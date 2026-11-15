// 发给本人的文字政策（docs/消息清单.md）：只有三类能出门——要本人拍板或动手的（decide）、本人提问的
// 回复（reply，由 act.ts 产生，过 sanitize）、本人明确说要的结果（result）。其余一律不推：卡片留在中枢
// 和看板上，适配器记一条压下原因。对照表没写过的卡片类型默认不推。所有出门的文字都过 sanitize()：
// 内部代号、hub= 版本串、绝对路径、堆栈、JSON 报文、报错原文，一个都不许出去。
import { redact } from "../../protocol/redact.ts";

export type Category = "decide" | "result";
export type Verdict = { send: true; category: Category } | { send: false; why: string };

/** 通道拿到手的卡片（/v1/cards/next 的视图）：没有 key/source，可判断的只有这些字段。 */
export type CardLike = {
  id: number;
  kind: string;
  state?: string;
  title: string;
  text?: string | null;
  detail?: string | null;
  options?: string[];
  recommend?: number | null;
  choice?: number | null;
  answer?: string | null;
  rule?: string | null;
};

export type PolicyRule = {
  /** 打在卡片标题上的正则（不加 ^$ 就自己包）。 */
  title?: string;
  /** 打在卡片正文+detail 上的正则。 */
  text?: string;
  /** 卡片 kind（ask / notice / 以后的新类型）。 */
  kind?: string;
  /** true 只匹配 open，false 只匹配非 open。 */
  open?: boolean;
  /** 精确匹配 state（open/decided/closed/…）。 */
  state?: string;
  /** 正文里「N 分钟」达到这个数才按 to 放行；不到就当没匹配上——设备离线的 2 小时线用。 */
  afterMinutes?: number;
  to: Category | "suppress";
  /** 压下/放行时记进状态的那句人话，审计用。 */
  note?: string;
};

export type NotifyPolicy = {
  /** 第一条命中的规则说了算；配置里的规则排在默认表前面。 */
  rules: PolicyRule[];
  /** 整类开关：false 就把这一类全压下，不用动规则表。 */
  send: { decide: boolean; result: boolean };
};

const MINUTES = /(\d+)\s*分钟/;
const match = (pattern: string | undefined, text: string) => pattern !== undefined && new RegExp(pattern).test(text);

// 对照《消息清单》第 3 节：压下的在前，拍板居中，结果靠 state 收尾；不中的默认不推。
export const DEFAULT_RULES: PolicyRule[] = [
  { title: "^AI Loop 进度", to: "suppress", note: "搭建进度不推" },
  { text: "^AI Loop 进度", to: "suppress", note: "搭建进度不推" },
  { text: "没有回音，不确定做没做完", to: "suppress", note: "超时没回音会自动处理" },
  { text: "次自动处理没跑完[\\s\\S]*会自动再试", to: "suppress", note: "还在自动重试" },
  { text: "档案写回(没写进去|失败了)", to: "suppress", note: "档案写回失败自动重试" },
  { title: "^接单程序没连上", afterMinutes: 120, to: "decide", note: "设备离线过 2 小时" },
  { kind: "ask", open: true, to: "decide", note: "等你拍板" },
  { kind: "notice", open: true, to: "decide", note: "要你处理" },
  { kind: "notice", state: "closed", to: "result", note: "结果知会" },
];

export const DEFAULT_POLICY: NotifyPolicy = { send: { decide: true, result: true }, rules: DEFAULT_RULES };

/** 配置文件里的 policy 段：send 整类开关 + rules 对照表（排在默认表前面，先命中先赢）。 */
export function loadPolicy(
  given?: { send?: { decide?: boolean; result?: boolean }; rules?: PolicyRule[] } | null,
): NotifyPolicy {
  return {
    send: { decide: given?.send?.decide !== false, result: given?.send?.result !== false },
    rules: [...(Array.isArray(given?.rules) ? given.rules : []), ...DEFAULT_RULES],
  };
}

export function classify(card: CardLike, policy: NotifyPolicy = DEFAULT_POLICY): Verdict {
  const body = `${card.text ?? ""}\n${card.detail ?? ""}`;
  for (const rule of policy.rules) {
    if (rule.kind !== undefined && rule.kind !== card.kind) continue;
    if (rule.state !== undefined && rule.state !== card.state) continue;
    if (rule.open !== undefined && rule.open !== (card.state === "open")) continue;
    if (rule.title !== undefined && !match(rule.title, card.title ?? "")) continue;
    if (rule.text !== undefined && !match(rule.text, body)) continue;
    if (rule.afterMinutes !== undefined) {
      // 时间差不够的离线类，这条规则认下这张卡但不放——不往下掉到「等处理通知也发」。
      const minutes = Number(MINUTES.exec(body)?.[1] ?? 0);
      if (minutes < rule.afterMinutes) return { send: false, why: `没到 ${rule.afterMinutes / 60} 小时线` };
    }
    if (rule.to === "suppress") return { send: false, why: rule.note ?? "清单不推" };
    return policy.send[rule.to]
      ? { send: true, category: rule.to }
      : { send: false, why: `整类已关（${rule.to}${rule.note ? `：${rule.note}` : ""}）` };
  }
  return { send: false, why: "不在推送清单" };
}

const MAX_TEXT = 500;
const MAX_LINES = 8;

/** 多行 JSON 整块剥除：一行以 { 或 [ 结尾视作块开头，按括号配平吞到闭合行；吞不下的按行剥「"键": 值」碎片。 */
function stripJsonBlocks(text: string): string {
  const kept: string[] = [];
  let depth = 0;
  for (const line of text.split("\n")) {
    if (depth === 0) {
      if (/[{[]\s*$/.test(line)) {
        depth = Math.max(1, (line.match(/[{[]/g)?.length ?? 0) - (line.match(/[}\]]/g)?.length ?? 0));
        continue;
      }
      kept.push(line);
      continue;
    }
    depth += (line.match(/[{[]/g)?.length ?? 0) - (line.match(/[}\]]/g)?.length ?? 0);
    if (depth < 0) depth = 0;
  }
  return kept.join("\n");
}

/** 出站净身：先过凭据脱敏，再出门禁——内部代号、版本串、路径、堆栈、JSON、报错原文，全留下。 */
export function sanitize(raw: string, max = MAX_TEXT): string {
  let out = stripJsonBlocks(redact(String(raw)));
  out = out
    .replace(/\b(?:hub|engine|main|app)=[0-9a-f]{7,64}\b/gi, "当前版本")
    .replace(/\b[0-9a-f]{32,64}\b/gi, "（长串略）")
    .replace(/~?\/(?:[\w.-]+\/)+[\w.-]+/g, "（路径略）")
    .replace(/[A-Za-z]:\\[\w\\.-]+/g, "（路径略）")
    .replace(/^[ \t]*at\s+[^\n]*$/gm, "")
    .replace(/^[ \t]*[{[][^\n]*[}\]][ \t]*$/gm, "")
    .replace(/^[ \t]*"(?:[^"\\]|\\.)*"[ \t]*:[^\n]*,[ \t]*$/gm, "")
    .replace(/^[ \t]*"(?:[^"\\]|\\.)*"[ \t]*:[ \t]*(?:"[^"\n]*"|-?[\d.eE+-]+|true|false|null|[[{])[ \t]*$/gm, "");
  for (let i = 0; i < 3; i++) out = out.replace(/\{[^{}\n]*\}/g, "（报文略）");
  out = out
    .replace(/\b[ST]\d{1,3}\b/g, "（编号略）")
    .replace(/第\s*\d+\s*轮/g, "（编号略）")
    .replace(/\b(?:run|event|session|card)[ _:-]?\d+\b/gi, "（编号略）")
    .replace(
      /\b(?:hub|worker|source|channel|agent|rule|lane|ref|via|from|subject|key|run|event|session|card)[:=：][\w@.:-]+/gi,
      "（编号略）",
    )
    .replace(/\b(?:ops|task|ai-loop|hops|gate|thread|elsewhere|catalog)\.[\w.-]+/g, "（编号略）")
    .replace(/\b(?:feishu|wechat|clawbot|desktop|schedule|local)[:][\w@.:-]+/g, "（编号略）")
    .replace(/分类[：:]\s*[a-z_]+/g, "（分类略）")
    .replace(
      /\b(?:transient_error|rate_limited|quota_exhausted|auth_invalid|need_owner|no_candidate|no_report|worker_offline|rule_deleted|max_failures|archive_conflict|stalled|hops_exceeded|unclassified|need_login|need_approval|env_missing|agent_error|receipt_unreadable|owner_stopped|nothing_to_do)\b/g,
      "（分类略）",
    )
    .replace(/\b[A-Za-z]*Error:\s*[^\n。！]{0,80}/g, "（报错略）")
    .replace(/\bFailed to [^\n。！]{0,60}/gi, "（报错略）")
    .replace(/\bAPI Error[^\n。！]{0,60}/gi, "（报错略）")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const lines = out.split("\n");
  if (lines.length > MAX_LINES) out = `${lines.slice(0, MAX_LINES).join("\n")}\n……（详情见看板）`;
  if (out.length > max) out = `${out.slice(0, max)}……（详情见看板）`;
  return out;
}

/** 卡片给本人看的写法：标题一行说清什么事，拍板类带选项和 # 号协议，来源名只在标题没说到时补一行。 */
export function renderOwnerCard(card: CardLike): string {
  const lines = [`【${sanitize(card.title)}】`];
  if (card.rule && !(card.title ?? "").includes(card.rule)) lines.push(`来自：${sanitize(card.rule)}`);
  const body = sanitize(card.text ?? "");
  if (body) lines.push(body);
  if (card.state && card.state !== "open") {
    if (card.state === "decided") {
      const picked = card.choice != null ? `第 ${card.choice + 1} 项` : sanitize(card.answer ?? "");
      if (picked) lines.push(`#${card.id} 已定：${picked}`);
    }
  } else if (card.kind === "notice") {
    lines.push(`回复 #${card.id} 确认 标记已处理`);
  } else {
    (card.options ?? []).forEach((option, i) => lines.push(`${i + 1}. ${sanitize(option)}`));
    const hint = card.recommend != null ? `（「确认」= 第 ${card.recommend + 1} 项）` : "";
    lines.push(`回复 #${card.id} <序号> 或一句话${hint}`);
  }
  return lines.join("\n");
}
