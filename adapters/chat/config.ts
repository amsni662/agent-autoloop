// Adapter configuration: every path and account the process needs comes from this file, nothing is baked in.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { PolicyRule } from "./notify.ts";

export type Features = { intake: boolean; notify: boolean; answers: boolean };
/** The outbound message policy, from the config file's `policy` section (see adapters/chat/notify.ts). */
export type PolicyConfig = {
  /** Whole-category switches: set one false to silence that class without touching the rule table. */
  send?: { decide?: boolean; result?: boolean };
  /** Extra mapping rules, tried before the built-in table — first match wins. */
  rules?: PolicyRule[];
  /** WeChat only: refuse sends when the reply credential is older than this — the platform accepts but never delivers. */
  tokenMaxAgeMs?: number;
};
export type ChatConfig = {
  hub: string;
  /** The only sender the adapter serves: a Feishu open_id or a WeChat userId. */
  me: string;
  keysFile: string;
  rulesFile: string;
  stateFile: string;
  features: Features;
  policy?: PolicyConfig;
  /** Feishu only: path to lark-cli. */
  lark?: string;
  /** WeChat only: the iLink binding profile (token, userId, baseUrl). */
  accountFile?: string;
  /** WeChat only: where the transport package (@tencent-weixin/openclaw-weixin) is installed, when the adapter's
   * own node_modules doesn't hold it — e.g. a shared install on the host it deploys to. */
  transportDir?: string;
};

const expand = (value: string) =>
  value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;

const need = (given: Record<string, unknown>, field: string, file: string) => {
  const value = given[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`配置 ${file} 缺 ${field}`);
  return value.trim();
};

export function loadConfig(file: string): ChatConfig {
  const given = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const features = (given.features ?? {}) as Partial<Features>;
  const config: ChatConfig = {
    hub: need(given, "hub", file).replace(/\/$/, ""),
    me: need(given, "me", file),
    keysFile: expand(need(given, "keysFile", file)),
    rulesFile: expand(need(given, "rulesFile", file)),
    stateFile: expand(need(given, "stateFile", file)),
    features: {
      intake: features.intake !== false,
      notify: features.notify !== false,
      answers: features.answers !== false,
    },
  };
  for (const field of ["lark", "accountFile", "transportDir"] as const) {
    if (typeof given[field] === "string") config[field] = expand(given[field]);
  }
  if (config.transportDir && !isAbsolute(config.transportDir)) {
    throw new Error(`配置 ${file} 的 transportDir 要写成绝对路径或 ~/ 开头`);
  }
  if (given.policy !== undefined) {
    if (typeof given.policy !== "object" || given.policy === null) throw new Error(`配置 ${file} 的 policy 要写成对象`);
    config.policy = given.policy as PolicyConfig;
  }
  for (const [field, value] of Object.entries(config)) {
    if (field.endsWith("File") && typeof value === "string" && !isAbsolute(value)) {
      throw new Error(`配置 ${file} 的 ${field} 要写成绝对路径或 ~/ 开头`);
    }
  }
  return config;
}

/** The only credentials the adapter ever holds: one source key, one channel key. */
export function loadKeys(file: string): { source: string; channel: string } {
  const given = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  for (const field of ["source", "channel"] as const) {
    if (typeof given[field] !== "string" || !given[field]) throw new Error(`密钥文件 ${file} 缺 ${field}`);
  }
  return { source: given.source as string, channel: given.channel as string };
}
