// 这个文件守着设备下架和断线改派。防的失败方式：下架的设备还领到新活；下架时手上已领的
// 活被掐断或回执被拒；角色链不跳过下架设备；固定 Agent 的活被改派给别的设备；下架状态本人
// 看不见或不是本人也能操作；接单程序在线却没再认领的轮次永远卡死或没核实就重派——在线不认领
// 满一个窗口才判「没跑成」重排队，设备不在线时一律保留归属；「还在跑」（回报里带着）或
// 「做完没交」（回执后到）的轮次被当成没跑成重跑造成重复执行；重派后旧令牌的结果还能生效。
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { decide } from "../kernel/decide.ts";
import { empty, evolve, rows, type Fact, type View } from "../kernel/evolve.ts";
import { credential } from "../kernel/credentials.ts";
import { parseRules } from "../protocol/rules.ts";
import { at, setup } from "./helpers.ts";

setup("offboard");

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const LEASE = 5 * MINUTE;
/** 在线不认领满这个窗口才判没跑成：远在租约之后，让「还在跑、做完没交」先核实完。 */
const LOST = 15 * MINUTE;

const environment = { secret: "test-offboard", publicUrl: "https://hub.test" };
const rules = parseRules(
  JSON.stringify({
    timezone: "UTC",
    sources: { app: { name: "应用" } },
    agents: {
      a1: { name: "甲", worker: "w1", use: "command", command: ["true"] },
      a2: { name: "乙", worker: "w2", use: "command", command: ["true"] },
    },
    rules: [
      { name: "甲事", when: { source: "app", types: ["job.a1"] }, to: "a1", cwd: "/tmp", prompt: "做" },
      { name: "角色事", when: { source: "app", types: ["job.role"] }, to: "role:quick", cwd: "/tmp", prompt: "做" },
    ],
  }),
  0,
  "UTC",
);
const catalog = {
  version: 1,
  roles: {
    quick: [
      { agent: "a1", device: "w1" },
      { agent: "a2", device: "w2" },
    ],
  },
};

class Hub {
  view: View = empty();
  log: Fact[] = [];
  now = at(0);
  constructor() {
    this.act("rules", rules);
    this.act("catalog", catalog);
  }
  act(type: string, ...args: unknown[]) {
    const decided = decide(this.view, { type, args }, this.now, environment);
    this.log.push(...decided.facts);
    this.view = evolve(this.view, decided.facts);
    return decided.value;
  }
  runTo(time: number) {
    for (let fired = 0; ; fired++) {
      const next = Math.min(Infinity, ...rows(this.view, "due").map((due) => due.at));
      if (next > time) break;
      assert.ok(fired < 100, "a deadline keeps coming due");
      this.now = Math.max(this.now, next);
      this.act("tick");
    }
    this.now = time;
  }
  /** 这台设备在线地走过一段时间：隔会儿报个到，带不带哪几轮看它说的。 */
  online(worker: string, running: number[], seconds: number) {
    for (let t = 0; t < seconds; t += 30) {
      this.act("heartbeat", worker, running);
      this.runTo(this.now + 30 * SECOND);
    }
  }
  run(id: number) {
    return this.view.get("runs", id)!;
  }
  cards() {
    return rows(this.view, "cards");
  }
  send(type: string, id: string) {
    this.act("ingest", "app", { id, type, subject: "", summary: "事" });
  }
}

const tokenOf = (hub: Hub, run: number) => credential(environment, "run", run, hub.run(run).issued);

test("下架的设备领不到新活，手上的照做、回执照收，恢复后再领", () => {
  const hub = new Hub();
  hub.send("job.a1", "e1");
  const job = hub.act("claimNext", "w1", "c1");
  assert.equal(job.rule.name, "甲事");

  hub.send("job.a1", "e2");
  const done = hub.act("drainWorker", "w1", "本人", { reason: "换机" });
  assert.equal(done.changed, true);
  assert.equal(done.inHand, 1);
  assert.equal(done.queued, 1);
  assert.ok(hub.view.get("drains", "w1"), "下架进了投影");
  assert.equal(hub.act("claimNext", "w1", "c2"), null, "下架还领到新活");
  // 手上的那一轮照样报到、照样交回执。
  hub.act("heartbeat", "w1", [job.run]);
  hub.act("finish", job.run, tokenOf(hub, job.run), { outcome: "done" });
  assert.equal(hub.run(job.run).state, "done");
  // 恢复接单：排着的还能领。
  assert.equal(hub.act("resumeWorker", "w1").changed, true);
  const again = hub.act("claimNext", "w1", "c3");
  assert.equal(again.rule.name, "甲事");
});

test("下架时角色链跳过下架设备，固定 Agent 的活等着不丢", () => {
  const hub = new Hub();
  for (const w of ["w1", "w2"]) hub.act("heartbeat", w, []);
  hub.act("drainWorker", "w1", "本人", {});
  // 角色事：链上 a1(w1) 下架中，轮到 a2(w2)。
  hub.send("job.role", "r1");
  const job = hub.act("claimNext", "w2", "c1");
  const resolved = JSON.parse(hub.run(job.run).resolved);
  assert.equal(resolved.picked, "a2");
  assert.deepEqual(resolved.skipped, [{ candidate: "a1", reason: "w1 下架中" }]);
  // 甲事固定派 a1(w1)：没人能接，留着不丢，也不假报改派。
  hub.send("job.a1", "f1");
  assert.equal(hub.act("claimNext", "w2", "c2"), null);
  assert.equal(hub.run(job.run + 1).state, "queued");
});

test("下架是本人的事：名字不认得、重复下架说实话", () => {
  const hub = new Hub();
  hub.act("heartbeat", "w1", []);
  assert.throws(() => hub.act("drainWorker", "没有这台", "本人", {}), /没有这台接单程序/);
  assert.equal(hub.act("drainWorker", "w1", "本人", { reason: "搬" }).changed, true);
  assert.equal(hub.act("drainWorker", "w1", "本人", { reason: "搬" }).changed, false);
  assert.equal(hub.act("resumeWorker", "w2").changed, false);
});

test("在线却不再认领的轮次：满核实窗判没跑成、重排队、同事项合轮", () => {
  const hub = new Hub();
  const t0 = hub.now;
  hub.send("job.a1", "e1");
  const job = hub.act("claimNext", "w1", "c1");
  // worker 一直在线、一直不报这一轮：先转 unknown（一个租约），再过核实窗才重排。
  hub.online("w1", [], (LEASE + SECOND) / SECOND);
  assert.equal(hub.run(job.run).state, "unknown");
  const missed = hub.run(job.run).missed_at;
  assert.ok(missed, "漏报没记账");
  // 核实窗内：还是 unknown，不重派——结果可能还在路上。
  hub.online("w1", [], (Date.parse(missed) + LOST - MINUTE - hub.now) / SECOND);
  assert.equal(hub.run(job.run).state, "unknown", "核实窗内就重派了");
  // 过窗：判没跑成，重新排队，attempts 记一次，unknown 卡合上。
  hub.online("w1", [], (3 * MINUTE) / SECOND);
  const run = hub.run(job.run);
  assert.equal(run.state, "queued", `满窗还没重排：${run.state}`);
  assert.equal(run.attempts, 1);
  assert.match(run.error, /没再认领/);
  assert.equal(run.claim, null);
  assert.equal(hub.cards().filter((card) => card.key === `run:${job.run}:unknown` && card.state === "open").length, 0);
  // 旧令牌的结果再交被拒——同一轮不会按两次记。
  assert.throws(() => hub.act("finish", job.run, tokenOf(hub, job.run), { outcome: "done" }), /不归这个令牌/);
  // 重排的轮次能再领、再跑完。
  const again = hub.act("claimNext", "w1", "c2");
  assert.equal(again.run, job.run);
  hub.act("finish", job.run, again.token, { outcome: "done" });
  assert.equal(hub.run(job.run).state, "done");
});

test("还在跑和做完没交的都不算没跑成", () => {
  const hub = new Hub();
  hub.send("job.a1", "e1");
  const job = hub.act("claimNext", "w1", "c1");
  // 先不报，进 unknown；再开始报「还在跑」：不重排、不盖章、照旧 unknown（行为规格）。
  hub.online("w1", [], (LEASE + SECOND) / SECOND);
  assert.equal(hub.run(job.run).state, "unknown");
  hub.online("w1", [job.run], (LOST + 2 * MINUTE) / SECOND);
  assert.equal(hub.run(job.run).state, "unknown", "还在跑的被重派了");
  // 做完没交：回执到了照样收。
  hub.act("finish", job.run, tokenOf(hub, job.run), { outcome: "done" });
  assert.equal(hub.run(job.run).state, "done");
});

test("设备整个不在线：已领的活保留归属，永不自动重派", () => {
  const hub = new Hub();
  hub.send("job.a1", "e1");
  const job = hub.act("claimNext", "w1", "c1");
  hub.act("heartbeat", "w1", [job.run]);
  // 此后再无心跳：claimed 永远留着，只有离线卡提醒。
  hub.runTo(hub.now + 60 * MINUTE);
  assert.equal(hub.run(job.run).state, "claimed");
  assert.equal(hub.run(job.run).missed_at, null, "没报到的活不该记漏报");
  // 回来了不带这一轮：先 unknown（现语义），核实窗内不重派，过窗才重排。
  const back = hub.now;
  hub.act("heartbeat", "w1", []);
  hub.runTo(hub.now + SECOND);
  assert.equal(hub.run(job.run).state, "unknown");
  hub.online("w1", [], (back + LOST - MINUTE - hub.now) / SECOND);
  assert.equal(hub.run(job.run).state, "unknown", "回来还没核实完就重派了");
  hub.online("w1", [], (3 * MINUTE) / SECOND);
  assert.equal(hub.run(job.run).state, "queued", "回来后不认领的过窗了还没重排");
});

test("断线期间新来的同事项并进重排的轮次", () => {
  const hub = new Hub();
  hub.send("job.a1", "e1");
  const job = hub.act("claimNext", "w1", "c1");
  hub.send("job.a1", "e2"); // 同一事项队列又来一条
  assert.equal(rows(hub.view, "runs", { state: "queued" }).length, 1);
  // 在线不认领到判没跑成。
  hub.online("w1", [], (LEASE + LOST + 2 * MINUTE) / SECOND);
  const run = hub.run(job.run);
  assert.equal(run.state, "queued");
  const events = rows(hub.view, "run_events", { run_id: job.run }).map((link) => link.event_id);
  assert.equal(events.length, 2, "新来的事项没并进重排的轮次");
  assert.equal(rows(hub.view, "runs", { state: "queued" }).length, 1, "同事项留了两轮");
});

test("状态里看得到下架", async () => {
  const { serve } = await import("../host/http.ts");
  const runtime = await import("./hub.ts");
  const owner = runtime.addKey("owner", "owner");
  const w1key = runtime.addKey("worker", "w1");
  const server = serve(0, "127.0.0.1", { commit: "abc123" });
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = async (path: string, key: string, body?: unknown) => {
      const res = await fetch(base + path, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: await res.json() };
    };
    // 不是本人密钥不能下架。
    assert.equal((await post("/v1/workers/w1/drain", w1key, {})).status, 401);
    const drained = await post("/v1/workers/w1/drain", owner, { reason: "换机" });
    assert.equal(drained.status, 200);
    assert.equal(drained.json.changed, true);
    const state = await (await fetch(`${base}/v1/state`, { headers: { authorization: `Bearer ${owner}` } })).json();
    assert.deepEqual(
      state.drains.map((d: any) => d.name),
      ["w1"],
    );
    assert.equal(state.agents.find((a: any) => a.id === "a1").draining, true);
    assert.equal(state.agents.find((a: any) => a.id === "a2").draining, false);
    // 接单程序看得到自己在下架。
    const work = await (
      await fetch(`${base}/v1/work?wait=0&claim=x&capacity=1`, {
        headers: { authorization: `Bearer ${w1key}` },
      })
    ).json();
    assert.equal(work.draining, true);
    assert.equal(work.job, null);
    const back = await post("/v1/workers/w1/resume", owner);
    assert.equal(back.json.changed, true);
    const state2 = await (await fetch(`${base}/v1/state`, { headers: { authorization: `Bearer ${owner}` } })).json();
    assert.deepEqual(state2.drains, []);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
