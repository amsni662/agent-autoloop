// 这个文件守着指令关口：开了 gate 的规则，事件不能直接派下去。
// 防的失败方式：重复指令不问就再跑一次；越权或代发的指令直接执行；判断轮拿不准、没跑成或被停时默认放行；
// 确认卡放行了别的指令、一张回答算两次、回答的人不在答复名单；没开 gate 的规则行为变了；
// 事件里别人写的字进了判断轮的提示词；身份表把同一个人错认成两个人；确认结果没进项目档案。
import assert from "node:assert/strict";
import { test } from "node:test";
import { setup } from "./helpers.ts";

setup("gate");
const { decide } = await import("../kernel/decide.ts");
const { empty, evolve, rows } = await import("../kernel/evolve.ts");
const { parseRules, RulesError } = await import("../protocol/rules.ts");
const { promptFor } = await import("../worker/contract.ts");

const environment = { secret: "gate-secret", publicUrl: "https://hub.test" };
const MIN = 60_000;
const t0 = Date.parse("2026-10-18T02:00:00.000Z"); // 10:00 Asia/Shanghai
const at = (m: number) => t0 + m * MIN;

const spec = JSON.stringify({
  timezone: "UTC",
  people: { me: { chat: "id_me", pad: "id_pad" } },
  sources: { chat: { name: "聊天" }, alt: { name: "另一渠道" } },
  agents: {
    a1: { name: "甲", worker: "w1", use: "command", command: ["true"] },
    a2: { name: "乙", worker: "w2", use: "command", command: ["true"] },
    j1: { name: "判", worker: "w1", use: "command", command: ["true"] },
  },
  channels: { chat: { name: "聊天", answerers: ["me"] } },
  defaultChannels: ["chat"],
  projects: { p1: { name: "项目一", cwd: "/tmp", archive: "archive/p1" } },
  gate: { judge: "指令判断", thresholds: { pass: 30, confirm: 60 }, unauthorized: "confirm" },
  rules: [
    {
      name: "项目活",
      when: { source: "chat", types: ["task.*"] },
      to: "a1",
      cwd: "/tmp",
      prompt: "做",
      gate: true,
      project: "p1",
    },
    {
      name: "别处活",
      when: { source: "alt", types: ["task.*"] },
      to: "a2",
      cwd: "/tmp",
      prompt: "做",
      gate: true,
    },
    {
      name: "指令判断",
      when: { source: "chat", types: ["gate.judge"] },
      to: "j1",
      cwd: "/tmp",
      prompt: "判",
      parallel: 5,
    },
    { name: "普通活", when: { source: "chat", types: ["plain.*"] }, to: "a1", cwd: "/tmp", prompt: "做" },
  ],
});
const rules = parseRules(spec, 0, "UTC");

function hub() {
  let v = evolve(empty(), decide(empty(), { type: "rules", args: [rules] }, 1, environment).facts);
  const act = (type: string, args: unknown[], now: number) => {
    const d = decide(v, { type, args }, now, environment);
    v = evolve(v, d.facts);
    return d.value;
  };
  return {
    act,
    gates: () => rows(v, "gates"),
    runs: (match = {}) => rows(v, "runs", match),
    run: (id: number) => v.get("runs", id),
    cards: (match = {}) => rows(v, "cards", match),
    events: () => rows(v, "events"),
    runEvents: (runId: number) => rows(v, "run_events", { run_id: runId }),
    writes: (match = {}) => rows(v, "archive_writes", match),
    get view() {
      return v;
    },
  };
}

const instruction = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "task.p1",
  subject: "p1",
  summary: text.slice(0, 200),
  detail: text,
  from: "id_me",
  ...extra,
});

const ingest = (h: ReturnType<typeof hub>, event: Record<string, unknown>, now: number) =>
  h.act("ingest", ["chat", event], now) as {
    event: number;
    routed: string[];
    gated?: { rule: string; state: string }[];
  };

const judgeRun = (h: ReturnType<typeof hub>, event: number) =>
  h.gates().find((g) => g.event === event)?.judge_run as number;

/** Claim every queued run a worker can take, in id order, and hand each the given receipt. */
function settleJudge(h: ReturnType<typeof hub>, run: number, receipt: Record<string, unknown>, now: number) {
  for (const claim of ["a", "b", "c", "d", "e"]) {
    const job = h.act("claimNext", ["w1", `judge-${run}-${claim}`], now) as { run: number; token: string } | null;
    if (job) {
      if (job.run === run) return h.act("finish", [run, job.token, receipt], now);
      h.act("finish", [job.run, job.token, { outcome: "done", gate: { verdict: "pass" } }], now);
      claim === "e" && assert.fail(`第 ${run} 轮没领到`);
      continue;
    }
    const job2 = h.act("claimNext", ["w2", `judge-${run}-${claim}`], now) as { run: number; token: string } | null;
    if (!job2) break;
    if (job2.run === run) return h.act("finish", [run, job2.token, receipt], now);
    h.act("finish", [job2.run, job2.token, { outcome: "done" }], now);
  }
  assert.fail(`第 ${run} 轮没被领到`);
}

const gateOf = (h: ReturnType<typeof hub>, event: number) => {
  const gate = h.gates().find((g) => g.event === event);
  assert.ok(gate, `事件 ${event} 没有关口记录`);
  return gate;
};

test("rules 校验：gate 配置和 people 的形状", () => {
  const mutate = (fn: (given: Record<string, any>) => void) => {
    const given = JSON.parse(spec);
    fn(given);
    return JSON.stringify(given);
  };
  assert.throws(
    () =>
      parseRules(
        mutate((given) => (given.gate.judge = "没有这条")),
        0,
        "UTC",
      ),
    RulesError,
    "judge 不是规则要拒",
  );
  assert.throws(
    () =>
      parseRules(
        mutate((given) => (given.gate.unauthorized = "maybe")),
        0,
        "UTC",
      ),
    RulesError,
  );
  assert.throws(
    () =>
      parseRules(
        mutate((given) => delete given.gate),
        0,
        "UTC",
      ),
    RulesError,
    "有 gate 规则却没有 gate 配置要拒",
  );
  assert.throws(
    () =>
      parseRules(
        mutate((given) => (given.gate.thresholds.pass = 80)),
        0,
        "UTC",
      ),
    RulesError,
    "pass 要小于 confirm",
  );
  const badRule = JSON.parse(spec);
  badRule.rules[3].gate = true;
  badRule.rules[3].when = { cron: "0 9 * * *" };
  assert.throws(() => parseRules(JSON.stringify(badRule), 0, "UTC"), RulesError, "定时规则不能开 gate");
  const badPeople = JSON.parse(spec);
  badPeople.people = { me: "id_me" };
  assert.throws(() => parseRules(JSON.stringify(badPeople), 0, "UTC"), RulesError, "people 要是一个身份表");
  // people 缺省、gate 缺省、老配置照旧
  const plain = JSON.parse(spec);
  delete plain.people;
  delete plain.gate;
  plain.rules = plain.rules.filter((r: { name: string }) => r.name === "普通活");
  assert.doesNotThrow(() => parseRules(JSON.stringify(plain), 0, "UTC"));
});

test("没开 gate 的规则：事件直接派，没有任何闸记录", () => {
  const h = hub();
  const ack = h.act("ingest", ["chat", { id: "p1", type: "plain.x", summary: "事" }], at(0));
  assert.equal(ack.gated, undefined);
  assert.equal(h.runs({ rule: "普通活" }).length, 1);
  assert.equal(h.gates().length, 0);
});

test("gate 规则：先派判断轮不派任务轮，指令只在资料里", () => {
  const h = hub();
  const ack = ingest(h, instruction("m1", "把周报写进项目档案"), at(0));
  assert.deepEqual(ack.gated, [{ rule: "项目活", state: "judging" }]);
  assert.equal(h.runs({ rule: "项目活" }).length, 0, "任务不能先派");
  const judge = judgeRun(h, ack.event);
  assert.ok(judge > 0, "要有一轮判断");
  const job = h.act("claimNext", ["w1", "c1"], at(1)) as { run: number; context: { events: { detail: string }[] } };
  assert.equal(job.run, judge);
  assert.equal(job.context.events[0].detail, "把周报写进项目档案");
  assert.ok(!promptFor(job as never, "/tmp/ctx.json").includes("把周报写进项目档案"), "指令文字不能进提示词");
});

test("判断 pass 且关口干净：放行，指令直接派下去", () => {
  const h = hub();
  const ack = ingest(h, instruction("m2", "更新说明书"), at(0));
  settleJudge(h, judgeRun(h, ack.event), { outcome: "done", gate: { verdict: "pass" } }, at(1));
  const gate = gateOf(h, ack.event);
  assert.equal(gate.state, "released");
  assert.equal(gate.verdict, "pass");
  const runs = h.runs({ rule: "项目活" });
  assert.equal(runs.length, 1);
  assert.deepEqual(
    h.runEvents(runs[0].id).map((l) => l.event_id),
    [ack.event],
  );
});

test("判断说冲突、取代、拿不准：都要本人强确认，不自动放行", () => {
  const h = hub();
  for (const [i, verdict] of ["conflict", "superseded", "unclear"].entries()) {
    const ack = ingest(h, instruction(`m3${i}`, `指令${i}`), at(i * 2));
    settleJudge(h, judgeRun(h, ack.event), { outcome: "done", gate: { verdict, reason: "说不清" } }, at(i * 2 + 1));
    assert.equal(gateOf(h, ack.event).state, "carded", verdict);
    assert.equal(h.cards({ state: "open" }).length, i + 1);
  }
  assert.equal(h.runs({ rule: "项目活" }).length, 0);
});

test("判断轮没跑成或没写判定：按强确认处理", () => {
  const h = hub();
  const a = ingest(h, instruction("m4a", "指令甲"), at(0));
  settleJudge(h, judgeRun(h, a.event), { outcome: "failed", error: "模型超时" }, at(1));
  assert.equal(gateOf(h, a.event).state, "carded");
  const b = ingest(h, instruction("m4b", "指令乙"), at(2));
  settleJudge(h, judgeRun(h, b.event), { outcome: "done", summary: "判完了但没写 gate 段" }, at(3));
  assert.equal(gateOf(h, b.event).state, "carded");
});

test("判断轮被本人停掉：按强确认处理", () => {
  const h = hub();
  const ack = ingest(h, instruction("m5", "指令"), at(0));
  h.act("cancel", [judgeRun(h, ack.event)], at(1));
  assert.equal(gateOf(h, ack.event).state, "carded");
  assert.ok(h.cards({ state: "open" }).length > 0);
});

test("重复指令：反馈已执行情况并问要不要重跑；变了的说法不算重复", () => {
  const h = hub();
  const first = ingest(h, instruction("m6a", "整理收件箱"), at(0));
  settleJudge(h, judgeRun(h, first.event), { outcome: "done", gate: { verdict: "pass" } }, at(1));
  const run = h.runs({ rule: "项目活" })[0];
  const job = h.act("claimNext", ["w1", "task1"], at(2)) as { run: number; token: string };
  h.act("finish", [job.run, job.token, { outcome: "done", summary: "收件箱整理完" }], at(3));
  const dup = ingest(h, instruction("m6b", "整理收件箱"), at(4));
  const gate = gateOf(h, dup.event);
  assert.equal(gate.state, "carded");
  assert.equal(gate.verdict, "duplicate");
  const card = h.cards({ state: "open" })[0];
  assert.ok(card.text.includes("收件箱整理完"), "要说出之前执行成什么样");
  // 不一样的说法走正常判断
  const fresh = ingest(h, instruction("m6c", "整理一下项目文档"), at(5));
  assert.equal(gateOf(h, fresh.event).state, "judging");
  // 回答「重跑一次」放行原指令
  h.act("answer", [card.id, { choice: 0, by: "本人" }], at(6));
  assert.equal(gateOf(h, dup.event).state, "released");
  assert.deepEqual(
    h.runEvents(h.runs({ rule: "项目活" })[1].id).map((l) => l.event_id),
    [dup.event, h.events().find((e) => e.type === "card.answered")!.id],
  );
});

test("乱序：指令在等判断时同泳道已完成更新的工作，再放行要先确认", () => {
  const h = hub();
  const old = ingest(h, instruction("m7a", "旧指令"), at(0));
  const fresh = ingest(h, instruction("m7b", "新指令"), at(1));
  // 旧指令的判断轮先领下但先不判：新指令先过闸、先做完
  const held = h.act("claimNext", ["w1", "held"], at(2)) as { run: number; token: string };
  assert.equal(held.run, judgeRun(h, old.event));
  settleJudge(h, judgeRun(h, fresh.event), { outcome: "done", gate: { verdict: "pass" } }, at(2));
  const job = h.act("claimNext", ["w1", "task2"], at(3)) as { run: number; token: string };
  h.act("finish", [job.run, job.token, { outcome: "done" }], at(4));
  // 旧指令判断才回来：它发出后泳道已经往前走过了
  h.act("finish", [held.run, held.token, { outcome: "done", gate: { verdict: "pass" } }], at(5));
  assert.equal(gateOf(h, old.event).state, "carded");
});

test("越权：不在身份表、不在答复名单、别人代发，按配置拒绝或强确认", () => {
  const h = hub();
  // 身份表里没有的人
  const stranger = ingest(h, instruction("m8a", "指令", { from: "id_stranger" }), at(0));
  assert.equal(gateOf(h, stranger.event).state, "carded");
  assert.ok(JSON.parse(gateOf(h, stranger.event).reasons).some((r: { kind: string }) => r.kind === "unauthorized"));
  assert.equal(h.runs({ rule: "项目活" }).length, 0);
  // 别人代发
  const proxied = ingest(h, instruction("m8b", "指令", { via: "id_other" }), at(1));
  assert.equal(gateOf(h, proxied.event).state, "carded");
  // 没带身份
  const anon = ingest(h, { id: "m8c", type: "task.p1", subject: "p1", detail: "指令" }, at(2));
  assert.equal(gateOf(h, anon.event).state, "carded");
  // unauthorized: "deny" 直接拒绝
  const strictGiven = JSON.parse(spec);
  strictGiven.gate.unauthorized = "deny";
  const strict = parseRules(JSON.stringify(strictGiven), 0, "UTC");
  let v = evolve(empty(), decide(empty(), { type: "rules", args: [strict] }, 1, environment).facts);
  const ack = decide(
    v,
    { type: "ingest", args: ["chat", instruction("m8d", "指令", { from: "id_stranger" })] },
    at(3),
    environment,
  );
  v = evolve(v, ack.facts);
  const gate = rows(v, "gates")[0];
  assert.equal(gate.state, "denied");
  assert.equal(rows(v, "runs").length, 0);
  assert.ok(rows(v, "cards").length > 0, "拒绝要告诉本人");
});

test("场景突变：常用渠道、时段、设备之外的组合要本人确认", () => {
  const h = hub();
  // 攒基线：同一个人同一渠道同一时段 5 条
  for (let i = 0; i < 5; i++) {
    const ack = ingest(h, instruction(`m9a${i}`, `日常指令${i}`), at(i * 4));
    settleJudge(h, judgeRun(h, ack.event), { outcome: "done", gate: { verdict: "pass" } }, at(i * 4 + 1));
    const job = h.act("claimNext", ["w1", `base${i}`], at(i * 4 + 2)) as { run: number; token: string };
    h.act("finish", [job.run, job.token, { outcome: "done" }], at(i * 4 + 3));
  }
  // 同一时段同一渠道：基线内，判断 pass 就放行
  const usual = ingest(h, instruction("m9b", "日常指令"), at(21));
  settleJudge(h, judgeRun(h, usual.event), { outcome: "done", gate: { verdict: "pass" } }, at(22));
  assert.equal(gateOf(h, usual.event).state, "released");
  // 凌晨 4 点（另一个时段带）：突变
  const night = Date.parse("2026-10-17T20:00:00.000Z");
  const odd = h.act("ingest", ["chat", instruction("m9c", "深夜指令")], night) as ReturnType<typeof ingest>;
  settleJudge(h, judgeRun(h, odd.event), { outcome: "done", gate: { verdict: "pass" } }, night + MIN);
  const gate = gateOf(h, odd.event);
  assert.equal(gate.state, "carded");
  assert.ok(JSON.parse(gate.reasons).some((r: { kind: string }) => r.kind === "mutation"));
});

test("确认绑定指令：回答只放行自己的那条，答过的卡不能再答", () => {
  const h = hub();
  const a = ingest(h, instruction("m10a", "指令甲"), at(0));
  settleJudge(h, judgeRun(h, a.event), { outcome: "done", gate: { verdict: "unclear" } }, at(1));
  const b = ingest(h, instruction("m10b", "指令乙"), at(2));
  settleJudge(h, judgeRun(h, b.event), { outcome: "done", gate: { verdict: "unclear" } }, at(3));
  const [cardA, cardB] = h.cards({ state: "open" });
  assert.ok(cardA.id !== cardB.id);
  const first = h.act("answer", [cardA.id, { choice: 0, by: "本人" }], at(4));
  assert.equal(first.changed, true);
  assert.equal(gateOf(h, a.event).state, "released");
  assert.equal(gateOf(h, b.event).state, "carded", "一张回答只能放行自己的指令");
  const again = h.act("answer", [cardA.id, { choice: 0, by: "本人" }], at(5));
  assert.equal(again.changed, false, "同一张卡不能算两次");
  const runs = h.runs({ rule: "项目活" });
  assert.equal(runs.length, 1);
  assert.deepEqual(
    h.runEvents(runs[0].id).map((l) => l.event_id),
    [a.event, h.events().find((e) => e.type === "card.answered")!.id],
  );
});

test("确认后指令的轮次能看到指令和拍板；项目规则的回答写进档案决定", () => {
  const h = hub();
  const ack = ingest(h, instruction("m11", "要确认的指令"), at(0));
  settleJudge(h, judgeRun(h, ack.event), { outcome: "done", gate: { verdict: "conflict" } }, at(1));
  const card = h.cards({ state: "open" })[0];
  h.act("answer", [card.id, { choice: 0, by: "本人" }], at(2));
  const run = h.runs({ rule: "项目活" })[0];
  const events = h.runEvents(run.id).map((l) => h.events().find((e) => e.id === l.event_id)!);
  assert.deepEqual(events.map((e) => e.type).sort(), ["card.answered", "task.p1"]);
  const write = h.writes().find((w) => w.kind === "decision");
  assert.ok(write, "回答要排档案写回");
  assert.equal(write.project, "p1");
  assert.ok(write.payload.includes("选了"));
});

test("答复人按人配置：people 展开身份，不在名单的答不了，老裸身份写法照旧", () => {
  const h = hub();
  const ack = ingest(h, instruction("m12", "指令"), at(0));
  settleJudge(h, judgeRun(h, ack.event), { outcome: "done", gate: { verdict: "unclear" } }, at(1));
  const card = h.cards({ state: "open" })[0];
  h.act("channelSeen", ["chat"], at(2));
  const out = h.act("nextCard", ["chat"], at(3)) as { id: number; version: number };
  assert.equal(out.id, card.id);
  h.act("delivered", ["chat", card.id, out.version, "ref-1"], at(4));
  // 人的另一个身份也算本人
  const ok = h.act("answer", [card.id, { channel: "chat", by: "id_pad", ref: "ref-1", choice: 1 }], at(5));
  assert.equal(ok.changed, true);
  // 换一张卡：陌生人不行
  const ack2 = ingest(h, instruction("m12b", "指令二"), at(6));
  settleJudge(h, judgeRun(h, ack2.event), { outcome: "done", gate: { verdict: "unclear" } }, at(7));
  const card2 = h.cards({ state: "open" })[0];
  h.act("nextCard", ["chat"], at(8));
  h.act("delivered", ["chat", card2.id, 1, "ref-2"], at(9));
  assert.throws(
    () => h.act("answer", [card2.id, { channel: "chat", by: "id_stranger", ref: "ref-2", choice: 0 }], at(10)),
    /不能回答/,
  );
});

test("阈值可以在规则里调", () => {
  const tightGiven = JSON.parse(spec);
  tightGiven.gate.thresholds = { pass: 10, confirm: 50 };
  const tight = parseRules(JSON.stringify(tightGiven), 0, "UTC");
  let v = evolve(empty(), decide(empty(), { type: "rules", args: [tight] }, 1, environment).facts);
  const act = (type: string, args: unknown[], now: number) => {
    const d = decide(v, { type, args }, now, environment);
    v = evolve(v, d.facts);
    return d.value;
  };
  // 场景基线为空时突变不计分，干净的指令 pass 后放行线以下仍放行
  const ack = act("ingest", ["chat", instruction("m13", "指令")], at(0)) as ReturnType<typeof ingest>;
  assert.equal(rows(v, "gates")[0].score < 10, true, "基线期不加分");
});
