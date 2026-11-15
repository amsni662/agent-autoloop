// 一轮结束后给回执定分类：先插件自己的 classify，再通用规则表，再退出码兜底。
// 通用匹配规则集中在这一个文件，补真实样本时只改这张表；厂商特有的格式在各插件的 classify 里。
import type { Adapter } from "./agents.ts";
import type { Category, Diagnosis, Result } from "../protocol/validate.ts";
import { nextOf } from "../protocol/validate.ts";
import { redact } from "../protocol/redact.ts";

/** 插件 classify 的返回：认出的分类；认不出来返回空，交给通用规则和退出码。 */
export type Classification = { category: Category; explain?: string; waitUntil?: string };

/** 一条识别规则：pattern 命中文本就归 category，explain 是一句人能看懂的说明。 */
export type ErrorRule = { category: Category; pattern: RegExp; explain: string };

// 通用规则表：顺序即优先级，特征明确的（额度、鉴权）在前，宽泛的（网络）在后。
// 标注「待真实样本校准」：这些字样按公开文档和各 CLI 的常见写法写，真实样本来了再校准。
export const GENERIC: ErrorRule[] = [
  // 待真实样本校准
  {
    category: "quota_exhausted",
    pattern:
      /insufficient[-_ ]?quota|quota exceeded|exceeded your current quota|credit balance|billing|out of (extra )?usage|额度用尽|余额不足|欠费/i,
    explain: "额度用尽",
  },
  // 待真实样本校准
  {
    category: "rate_limited",
    pattern: /rate[-_ ]?limit|rate_limit_exceeded|\b429\b|too many requests|请求过[多快]|被限流/i,
    explain: "被限流",
  },
  // 待真实样本校准
  {
    category: "auth_invalid",
    pattern:
      /\b401\b|unauthorized|invalid (api[-_ ]?key|token|credentials?)|token (has )?expired|session expired|鉴权失效|凭证(无效|过期)/i,
    explain: "鉴权失效",
  },
  // 待真实样本校准
  {
    category: "need_login",
    pattern: /not logged in|please (log ?in|sign ?in)|login required|run .?login|未登录|请(先|重新)登录/i,
    explain: "需要登录",
  },
  {
    category: "env_missing",
    pattern:
      /command not found|ENOENT|no such file or directory|is not installed|找不到|目录不存在|没有.{0,20}的插件|启动不了/i,
    explain: "环境缺东西",
  },
  // 待真实样本校准
  {
    category: "transient_error",
    pattern:
      /ECONN(REFUSED|RESET|ABORTED)|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|\b50[234]\b|network error|stream (error|disconnected)|连接(失败|中断|被重置)/i,
    explain: "临时网络或服务错误",
  },
];

/** 在一段文本上跑规则表：插件特有的规则放前面，通用规则兜底。 */
export function matchError(text: string, extra: ErrorRule[] = []): Classification | null {
  for (const rule of [...extra, ...GENERIC]) {
    if (rule.pattern.test(text)) return { category: rule.category, explain: rule.explain };
  }
  return null;
}

// 待真实样本校准：等多久只认明说秒数或时长的写法，时刻类的写法（几点重置）先不猜。
/** 报错里明说等多久：retry-after 秒数、try again in N 分钟之类。解析不出返回 undefined。 */
export function waitSeconds(text: string): number | undefined {
  const retryAfter = /retry[-_ ]?after[: =]?\s*(\d+(?:\.\d+)?)\s*s?\b/i.exec(text);
  if (retryAfter) return Number(retryAfter[1]);
  const tryAgain = /(?:try again|retry) in (\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i.exec(
    text,
  );
  if (tryAgain)
    return Number(tryAgain[1]) * (tryAgain[2].startsWith("h") ? 3600 : tryAgain[2].startsWith("m") ? 60 : 1);
  return undefined;
}

export type DiagnoseInput = {
  outcome: Result["outcome"];
  /** 被停的原因：cancel 是本人停的，timeout 超时，finished 报了完成但进程不退。 */
  why?: "cancel" | "timeout" | "finished";
  error?: string;
  /** stdout/stderr 的末尾一段，匹配和留原文都够用了。 */
  stdout?: string;
  stderr?: string;
  code?: number | null;
  adapter?: Adapter | null;
  /** 回执作废（读不懂、重写仍坏）：结局按第一行算，分类记 receipt_unreadable。 */
  unreadable?: boolean;
  device: string;
  agent: string;
  model?: string;
  /** 这轮输出的位置（run 目录），通知里指给本人看原文。 */
  output?: string;
  now?: () => number;
};

// 原文一律先脱敏再留：stderr 和报错里可能带着令牌、私钥、授权头。
const clip = (text: string | undefined, length: number) => {
  const cut = (text ?? "").trim().slice(-length);
  return cut ? redact(cut) : undefined;
};

/** 一轮结束后生成 diagnosis。顺序：结局 > 作废 > 被停 > 插件 > 通用规则 > 退出码 > 兜底。 */
export function diagnose(input: DiagnoseInput): Diagnosis {
  const now = input.now ?? Date.now;
  const base = {
    device: input.device,
    agent: input.agent,
    ...(input.model && { model: input.model }),
    ...(input.output && { output: input.output }),
  };
  const make = (category: Category, explain?: string, waitUntil?: string, raw?: string): Diagnosis => ({
    category,
    ...(explain && { explain: redact(explain.slice(0, 500)) }),
    ...base,
    next: nextOf(category, waitUntil),
    ...(waitUntil && { waitUntil }),
    ...(raw && { raw: raw.slice(-4000) }),
  });
  // 回执作废最先算：按第一行结局处理，但分类记「读不懂」。
  if (input.unreadable) {
    const diagnosis = make(
      "receipt_unreadable",
      input.error,
      undefined,
      clip(input.stdout || input.stderr || input.error, 4000),
    );
    diagnosis.next = input.outcome === "failed" ? "retry" : "none";
    return diagnosis;
  }
  if (input.outcome === "done") return make("completed");
  if (input.outcome === "nothing") return make("nothing_to_do");
  if (input.outcome === "cancelled") return make("owner_stopped");
  // 超时也带原文：卡在哪一步、最后说了什么，本人要能看到。
  if (input.why === "timeout") return make("timeout", input.error, undefined, clip(input.stderr || input.stdout, 4000));
  if (input.why === "finished")
    return make("stalled", input.error, undefined, clip(input.stderr || input.stdout, 4000));
  const text = `${input.error ?? ""}\n${input.stderr ?? ""}\n${input.stdout ?? ""}`;
  const raw = () => clip(input.stderr || input.stdout || input.error, 4000);
  const waitUntil = () => {
    const seconds = waitSeconds(text);
    return seconds === undefined ? undefined : new Date(now() + seconds * 1000).toISOString();
  };
  const plugin = input.adapter?.classify?.(input.stdout ?? "", input.stderr ?? "", input.code ?? null);
  if (plugin) return make(plugin.category, plugin.explain ?? input.error, plugin.waitUntil ?? waitUntil(), raw());
  const matched = matchError(text);
  if (matched) return make(matched.category, matched.explain, waitUntil(), raw());
  if (typeof input.code === "number") {
    if (input.code === 126 || input.code === 127) return make("env_missing", input.error, undefined, raw());
    if (input.code !== 0) return make("crashed", input.error ?? `进程退出码 ${input.code}`, undefined, raw());
  }
  // 兜底必须留下原文和位置，不能只写「执行不了」。
  return make("unclassified", input.error ?? "分不出这是什么失败", undefined, raw() ?? "(没有输出)");
}
