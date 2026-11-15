// 这个文件守着角色派单和额度改派。防的失败方式：role: 写法解析不了或派错人；角色链不从上往下取；
// 被限流/额度用尽的模型还被重复派；候选设备不在线、没登记、没空位时还派给它；全链不可用把通知刷爆；
// 领活理由没落进轮次记录；清单文件坏了还生效；老 to: agent 规则行为变了。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

setup("roles");
const { decide } = await import("../kernel/decide.ts");
const { empty, evolve, rows } = await import("../kernel/evolve.ts");
const { parseRules, RulesError } = await import("../protocol/rules.ts");
const { parseRolesFile, loadCatalog } = await import("../host/catalog.ts");

const environment = { secret: "roles-secret", publicUrl: "https://hub.test" };
const MINUTE = 60_000;

const spec = JSON.stringify({
  timezone: "UTC",
  sources: { app: { name: "应用" } },
  agents: {
    a1: { name: "甲", worker: "w1", use: "command", command: ["true"], model: "m1", maxActive: 1 },
    a3: { name: "丙", worker: "w1", use: "command", command: ["true"], model: "m3" },
    a2: { name: "乙", worker: "w2", use: "command", command: ["true"], model: "m2" },
  },
  rules: [
    { name: "快事", when: { source: "app", types: ["quick.job"] }, to: "role:quick", cwd: "/tmp", prompt: "做" },
    { name: "老规则", when: { source: "app", types: ["old.job"] }, to: "a1", cwd: "/tmp", prompt: "做" },
  ],
});
const rules = parseRules(spec, 0, "UTC");
const catalog = {
  version: 1,
  roles: {
    quick: [
      { agent: "a1", device: "w1", model: "m1" },
      { agent: "a3", device: "w1", model: "m3" },
      { agent: "a2", device: "w2", model: "m2" },
    ],
  },
};

function hub(withCatalog = true) {
  let v = evolve(empty(), decide(empty(), { type: "rules", args: [rules] }, 1, environment).facts);
  const act = (type: string, args: unknown[], now: number) => {
    const d = decide(v, { type, args }, now, environment);
    v = evolve(v, d.facts);
    return d.value;
  };
  if (withCatalog) act("catalog", [catalog], 2);
  return {
    act,
    run: (id: number) => rows(v, "runs", { id })[0],
    cards: (match: Parameters<typeof rows>[2] = {}) => rows(v, "cards", match),
    holds: () => rows(v, "model_holds"),
    get view() {
      return v;
    },
  };
}

const quickEvent = (h: ReturnType<typeof hub>, id: string, now: number) =>
  h.act("ingest", ["app", { id, type: "quick.job", subject: "", summary: "事" }], now);

test("role: 写法进规则，写错照样拒", () => {
  const given = (to: string) => spec.replace('"to":"role:quick"', `"to":"${to}"`);
  assert.doesNotThrow(() => parseRules(given("role:bulk-x"), 0, "UTC"));
  for (const bad of ["role:", "role:Quick", "role:甲", "nosuch"]) {
    assert.throws(() => parseRules(given(bad), 0, "UTC"), RulesError, bad);
  }
});

test("角色链从上往下取第一个能用的，理由写进轮次", () => {
  const h = hub();
  h.act("heartbeat", ["w1", []], 3);
  quickEvent(h, "e1", 3);
  const job = h.act("claimNext", ["w1", "c1"], 4);
  assert.equal(job.agent.id, "a1");
  const run = h.run(job.run);
  const resolved = JSON.parse(run.resolved);
  assert.equal(resolved.role, "quick");
  assert.equal(resolved.picked, "a1");
});

test("高优先级候选能用时，别的设备的领活不抢", () => {
  const h = hub();
  h.act("heartbeat", ["w1", []], 3);
  quickEvent(h, "e1", 3);
  assert.equal(h.act("claimNext", ["w2", "c2"], 4), null);
});

test("首选候选的模型被按住，改派下一个并在轮次里记下原因", () => {
  const h = hub();
  h.act("heartbeat", ["w1", []], 3);
  quickEvent(h, "e1", 3);
  const job = h.act("claimNext", ["w1", "c1"], 4);
  const until = new Date(5 + 60 * MINUTE).toISOString();
  h.act(
    "finish",
    [job.run, job.token, { outcome: "failed", diagnosis: { category: "rate_limited", model: "m1", waitUntil: until } }],
    5,
  );
  assert.equal(h.holds()[0].model, "m1");
  // 同一轮当轮改派：a1 的 m1 被按住，排队轮立刻由 a3 接走
  const next = h.act("claimNext", ["w1", "c2"], 6);
  assert.equal(next.run, job.run);
  assert.equal(next.agent.id, "a3");
  const resolved = JSON.parse(h.run(job.run).resolved);
  assert.equal(resolved.picked, "a3");
  assert.equal(resolved.skipped[0].candidate, "a1");
  assert.match(resolved.skipped[0].reason, /m1/);
});

test("候选所在设备不在线就跳过", () => {
  const h = hub();
  // w1 从未报到：a1、a3 都不可用，轮到 w2 上的 a2
  quickEvent(h, "e1", 3);
  const job = h.act("claimNext", ["w2", "c2"], 4);
  assert.equal(job.agent.id, "a2");
});

test("候选没空位就跳过", () => {
  const h = hub();
  h.act("heartbeat", ["w1", []], 3);
  // a1 的 maxActive 是 1：先让老规则占住它
  h.act("ingest", ["app", { id: "e0", type: "old.job", subject: "", summary: "事" }], 3);
  const held = h.act("claimNext", ["w1", "c0"], 4);
  assert.equal(held.agent.id, "a1");
  quickEvent(h, "e1", 5);
  const job = h.act("claimNext", ["w1", "c1"], 6);
  assert.equal(job.agent.id, "a3");
  assert.match(JSON.parse(h.run(job.run).resolved).skipped[0].reason, /没空位/);
});

test("整条链都不能用时只通知一次，轮次推到最早恢复时刻", () => {
  const h = hub();
  h.act("heartbeat", ["w1", []], 3);
  quickEvent(h, "e1", 3);
  const job = h.act("claimNext", ["w1", "c1"], 4);
  const t1 = new Date(5 + 60 * MINUTE).toISOString();
  const t2 = new Date(5 + 30 * MINUTE).toISOString();
  // m1、m3 接连被限流：a2 的 w2 从未报到，全链不可用
  h.act(
    "finish",
    [job.run, job.token, { outcome: "failed", diagnosis: { category: "rate_limited", model: "m1", waitUntil: t1 } }],
    5,
  );
  const second = h.act("claimNext", ["w1", "c2"], 6);
  h.act(
    "finish",
    [
      second.run,
      second.token,
      { outcome: "failed", diagnosis: { category: "quota_exhausted", model: "m3", waitUntil: t2 } },
    ],
    7,
  );
  const run = h.run(job.run);
  assert.equal(run.state, "queued");
  assert.equal(Date.parse(run.not_before), Date.parse(t2), "探测点取最早的恢复时刻");
  const cards = h.cards({ key: `run:${job.run}:no-candidate` });
  assert.equal(cards.length, 1);
  assert.match(cards[0].text, /没有能用的候选/);
  h.act("claimNext", ["w1", "c3"], 8);
  h.act("claimNext", ["w2", "c4"], 9);
  assert.equal(h.cards({ key: `run:${job.run}:no-candidate` }).length, 1, "不重复通知");
});

test("hold 到点自动恢复", () => {
  const h = hub();
  h.act("heartbeat", ["w1", []], 3);
  quickEvent(h, "e1", 3);
  const job = h.act("claimNext", ["w1", "c1"], 4);
  const until = new Date(5 + 10 * MINUTE).toISOString();
  h.act(
    "finish",
    [job.run, job.token, { outcome: "failed", diagnosis: { category: "rate_limited", model: "m1", waitUntil: until } }],
    5,
  );
  // 还没到点：a3 接走（上一轮当轮改派），把它的回执也按失败处理
  const again = h.act("claimNext", ["w1", "c2"], 6);
  assert.equal(again.agent.id, "a3");
  h.act("finish", [again.run, again.token, { outcome: "failed", error: "又挂了" }], 7);
  // 过点后再来一轮：m1 恢复，a1 重新排第一
  h.act("heartbeat", ["w1", []], 5 + 11 * MINUTE);
  quickEvent(h, "e2", 5 + 11 * MINUTE);
  const fresh = h.act("claimNext", ["w1", "c3"], 5 + 11 * MINUTE + 1);
  assert.equal(fresh.agent.id, "a1");
});

test("写死 Agent 的老规则：模型被按住时也不派", () => {
  const h = hub();
  h.act("heartbeat", ["w1", []], 3);
  h.act("ingest", ["app", { id: "e0", type: "old.job", subject: "", summary: "事" }], 3);
  const job = h.act("claimNext", ["w1", "c0"], 4);
  const until = new Date(5 + 60 * MINUTE).toISOString();
  h.act(
    "finish",
    [job.run, job.token, { outcome: "failed", diagnosis: { category: "rate_limited", model: "m1", waitUntil: until } }],
    5,
  );
  assert.equal(h.act("claimNext", ["w1", "c1"], 6), null, "同一个模型不连着重试");
});

test("没加载清单时 role: 规则不误派，只通知一次", () => {
  const h = hub(false);
  quickEvent(h, "e1", 3);
  assert.equal(h.act("claimNext", ["w1", "c1"], 4), null);
  const cards = h.cards({ key: "run:1:no-candidate" });
  assert.equal(cards.length, 1);
});

test("清单输入进 config，清单坏通知一次", () => {
  const h = hub(false);
  h.act("catalog", [catalog], 3);
  assert.equal(h.view.get("config", "catalog")?.value.roles.quick[0].agent, "a1");
  h.act("catalogError", ["manifest 哈希对不上"], 4);
  h.act("catalogError", ["manifest 哈希对不上"], 5);
  assert.equal(h.cards().filter((c) => c.key.startsWith("catalog:")).length, 1);
});

test("roles.yaml 受限格式解析", () => {
  const parsed = parseRolesFile(
    "# 注释\nquick:\n  - device: w1\n    agent: a1 # 行内注释\n    model: m1\n    when: 本机优先\n  - agent: a2\n\nbulk:\n  - agent: a3\n",
  );
  assert.deepEqual(parsed.quick[0], { device: "w1", agent: "a1", model: "m1", when: "本机优先" });
  assert.deepEqual(parsed.quick[1], { agent: "a2" });
  assert.deepEqual(parsed.bulk[0], { agent: "a3" });
  for (const bad of ["quick: x\n", "quick:\n - 乱写\n", "quick:\n  - agent: a1\n    bogus: x\n", "- agent: a1\n"]) {
    assert.throws(() => parseRolesFile(bad), Error, bad);
  }
});

test("loadCatalog 校验哈希和格式，坏了拒绝", () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-"));
  const put = (name: string, text: string) => writeFileSync(join(dir, name), text);
  const rolesText = "quick:\n  - agent: a1\n";
  const modelsText = "# 模型\n";
  put("roles.yaml", rolesText);
  put("models.md", modelsText);
  // manifest 哈希故意写错 → 拒绝
  put(
    "manifest.json",
    JSON.stringify({
      version: 1,
      files: { "roles.yaml": "sha256:0".padEnd(71, "0"), "models.md": "sha256:0".padEnd(71, "0") },
    }),
  );
  assert.ok(loadCatalog(dir).problem);
  // 改对哈希 → 通过
  const sha = (t: string) => "sha256:" + createHash("sha256").update(t).digest("hex");
  put(
    "manifest.json",
    JSON.stringify({
      version: 1,
      generatedAt: "2026-11-15T00:00:00Z",
      files: { "roles.yaml": sha(rolesText), "models.md": sha(modelsText) },
    }),
  );
  const ok = loadCatalog(dir);
  assert.equal(ok.catalog?.roles.quick[0].agent, "a1");
  // 文件被改但没更新 manifest → 拒绝
  put("roles.yaml", "quick:\n  - agent: a2\n");
  assert.ok(loadCatalog(dir).problem);
});
