// 回执分类的代码表：中枢和接单程序共用。含义与分组见 docs/ai-loop/回执分类.md。

/** 回执里的分类代码。`unclassified` 是兜底，必须带 raw 和 output。 */
export const CATEGORIES = [
  "completed",
  "nothing_to_do",
  "rate_limited",
  "quota_exhausted",
  "timeout",
  "stalled",
  "crashed",
  "transient_error",
  "agent_error",
  "need_login",
  "need_approval",
  "auth_invalid",
  "env_missing",
  "worker_offline",
  "no_report",
  "receipt_unreadable",
  "owner_stopped",
  "max_failures",
  "rule_deleted",
  "no_candidate",
  "unclassified",
] as const;

export type Category = (typeof CATEGORIES)[number];

/** `next` 的取值：说明性字段，中枢按 category 分组决定行为，不信它。 */
export const NEXTS = ["rerouted", "wait_until", "need_owner", "retry", "none"] as const;
export type Next = (typeof NEXTS)[number];

export type Diagnosis = {
  category: Category;
  explain?: string;
  device?: string;
  agent?: string;
  model?: string;
  next?: Next;
  waitUntil?: string;
  raw?: string;
  output?: string;
};

/** 要人处理的一组：不再自动重试，转提问卡片。 */
export const NEED_OWNER: ReadonlySet<Category> = new Set([
  "need_login",
  "need_approval",
  "auth_invalid",
  "env_missing",
]);

/** 限流和额度：照上游重试，另外记 model_holds（阶段 3 改派用）。 */
export const HOLD_MODEL: ReadonlySet<Category> = new Set(["rate_limited", "quota_exhausted"]);

/** 分类代码的中文标签，通知和卡片 detail 用。 */
export const LABELS: Record<Category, string> = {
  completed: "已完成",
  nothing_to_do: "没事可做",
  rate_limited: "被限流",
  quota_exhausted: "额度用尽",
  timeout: "超时",
  stalled: "卡住不动",
  crashed: "异常退出",
  transient_error: "临时错误",
  agent_error: "Agent 报错",
  need_login: "需要登录",
  need_approval: "需要拍板",
  auth_invalid: "鉴权失效",
  env_missing: "环境缺东西",
  worker_offline: "接单程序不在线",
  no_report: "超时未报到",
  receipt_unreadable: "回执读不懂",
  owner_stopped: "本人停止",
  max_failures: "连续失败达上限",
  rule_deleted: "规则已删",
  no_candidate: "没有能用的候选",
  unclassified: "未能分类",
};

/** 由分类和等待时刻推出 next。接单程序用；中枢自己处理时不看它。 */
export function nextOf(category: Category, waitUntil?: string): Next {
  if (NEED_OWNER.has(category)) return "need_owner";
  if (HOLD_MODEL.has(category)) return waitUntil ? "wait_until" : "retry";
  switch (category) {
    case "completed":
    case "nothing_to_do":
    case "owner_stopped":
    case "max_failures":
    case "rule_deleted":
      return "none";
    default:
      return "retry";
  }
}
