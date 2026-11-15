// The Mini role catalog: the shell reads catalog/, checks manifest.json's hashes and the files' shapes, and hands the
// kernel the parsed roles. A bad or tampered catalog is refused — the last good one keeps running and the owner hears.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { HOME } from "./home.ts";
import type { Catalog, CatalogCandidate } from "../kernel/rules.ts";

/** 清单和 rules.json 一样是本机配置：默认 HOME/catalog；要直接读项目里那份就用 AGENT_AUTOLOOP_CATALOG 指过去。 */
export const CATALOG_DIR = process.env.AGENT_AUTOLOOP_CATALOG ?? path.join(HOME, "catalog");

const sha256 = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
const ROLE = /^([a-z][a-z0-9-]*):$/;
const FIELD = /^([a-z]+):[ \t]+(.+)$/;
const FIELDS = new Set(["device", "agent", "model", "when"]);
const LINE = 200;

/**
 * roles.yaml 的受限格式（清单是人手写的，YAML 子集就够，不引依赖）：顶层是 `角色:` 一行；角色下面是候选条目，
 * 每条以 `- 字段: 值` 开头、后面跟 `字段: 值` 的缩进行；# 是注释（行首或值前），空行跳过。其余写法一律报错。
 */
export function parseRolesFile(text: string): Record<string, CatalogCandidate[]> {
  const roles: Record<string, CatalogCandidate[]> = {};
  let role: string | null = null;
  let candidate: Partial<CatalogCandidate> | null = null;
  const field = (name: string, value: string, where: string) => {
    if (!candidate) throw new Error(`${where}：候选字段要写在 - 开头的条目里`);
    if (!FIELDS.has(name)) throw new Error(`${where}：不认识的候选字段 ${name}`);
    if (name in candidate) throw new Error(`${where}：字段 ${name} 重复了`);
    (candidate as Record<string, string>)[name] = value;
  };
  for (const [index, raw] of text.split("\n").entries()) {
    const where = `roles.yaml 第 ${index + 1} 行`;
    if (raw.length > LINE * 10) throw new Error(`${where}：太长了`);
    const line = raw.replace(/[ \t]+#.*$/, "").replace(/\s+$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const top = ROLE.exec(line);
    if (top) {
      role = top[1];
      if (role in roles) throw new Error(`${where}：角色 ${role} 重复了`);
      roles[role] = [];
      candidate = null;
      continue;
    }
    const item = /^ +- (.+)$/.exec(line);
    if (item && !item[1].includes(":")) throw new Error(`${where}：候选要写成 - 字段: 值`);
    if (item) {
      if (!role) throw new Error(`${where}：候选要写在某个角色下面`);
      const match = FIELD.exec(item[1]);
      if (!match) throw new Error(`${where}：候选条目要写成 - 字段: 值`);
      candidate = {};
      roles[role].push(candidate as CatalogCandidate);
      field(match[1], match[2].trim(), where);
      continue;
    }
    const member = /^ {2,}([a-z]+):[ \t]+(.+)$/.exec(line);
    if (member && item === null) {
      field(member[1], member[2].trim(), where);
      continue;
    }
    throw new Error(`${where}：看不懂这一行`);
  }
  for (const [name, chain] of Object.entries(roles)) {
    for (const [i, c] of chain.entries()) {
      if (!c.agent) throw new Error(`角色 ${name} 第 ${i + 1} 个候选缺 agent`);
    }
  }
  return roles;
}

/** 读 catalog/ 并校验：manifest.json 的形状、roles.yaml 的格式、两份文件和 manifest 记的哈希一致。 */
export function loadCatalog(dir = CATALOG_DIR): { catalog?: Catalog; problem?: string } {
  let manifest: { version?: unknown; files?: Record<string, unknown>; generatedAt?: unknown };
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
  } catch (error) {
    // 没有清单不算坏：规则照旧按 Agent 派。有了 manifest 却读不了才是问题。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return { problem: `catalog 清单读不了：manifest.json ${(error as NodeJS.ErrnoException).code ?? error}` };
  }
  try {
    const files = manifest?.files;
    if (
      !manifest ||
      typeof manifest !== "object" ||
      !Number.isInteger(manifest.version) ||
      !files ||
      typeof files !== "object" ||
      Object.keys(files).sort().join() !== "models.md,roles.yaml" ||
      !Object.values(files).every((hash) => typeof hash === "string" && /^sha256:[0-9a-f]{64}$/.test(hash))
    ) {
      throw new Error("manifest.json 要有 version（整数）和 files（roles.yaml、models.md 各一条 sha256: 哈希）");
    }
    const rolesText = readFileSync(path.join(dir, "roles.yaml"), "utf8");
    const modelsText = readFileSync(path.join(dir, "models.md"), "utf8");
    for (const [name, text] of [
      ["roles.yaml", rolesText],
      ["models.md", modelsText],
    ] as const) {
      if (files[name] !== sha256(text)) throw new Error(`${name} 和 manifest.json 记的哈希对不上，清单没生效`);
    }
    return {
      catalog: {
        version: manifest.version as number,
        ...(typeof manifest.generatedAt === "string" && { generatedAt: manifest.generatedAt.slice(0, 100) }),
        roles: parseRolesFile(rolesText),
      },
    };
  } catch (error) {
    return { problem: `catalog 清单读不了：${(error as NodeJS.ErrnoException).message ?? error}` };
  }
}
