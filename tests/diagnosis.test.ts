// 这个文件守着回执分类。防的失败方式：分类丢了或存不进投影；要人处理的失败被自动重试白烧额度；
// 限流和额度没记 model_holds，阶段 3 的改派没有依据；中枢补的分类（不在线、没报到、停止）没落进卡片；
// 兜底分类不带原文位置；老回执（没有 diagnosis）被拒或行为变了；已知报错格式被分错类。
// 各插件 RULES 里标注「待真实样本校准」的写法，这里的样例就是它们防回归的依据。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("diagnosis");
const folder = join(home, "project");
mkdirSync(folder);
process.env.AGENT_AUTOLOOP_PUBLIC_URL = "https://hub.test";
const { createWorker } = await import("../worker/worker.ts");
const { diagnose, waitSeconds } = await import("../worker/diagnose.ts");
const { decide } = await import("../kernel/decide.ts");
const { empty, evolve, rows } = await import("../kernel/evolve.ts");
type Match = import("../kernel/evolve.ts").Match;
const { parseRules } = await import("../protocol/rules.ts");
const { parseResult } = await import("../protocol/validate.ts");
const { InputError } = await import("../kernel/errors.ts");
const claude = (await import("../plugins/claude/agent.ts")).default;
const codex = (await import("../plugins/codex/agent.ts")).default;
const command = (await import("../plugins/command/agent.ts")).default;

const environment = { secret: "simulation-secret", publicUrl: "https://hub.test" };
const rules = parseRules(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"), 0, "UTC");
const seeded = (given = rules) =>
  evolve(empty(), decide(empty(), { type: "rules", args: [given] }, 1, environment).facts);

/** 中枢测试架：ingest 排队、claimNext 领走、finish 交回执，之后直接看投影。 */
function hub(given = rules) {
  let v = seeded(given);
  const act = (type: string, args: unknown[], now: number) => {
    const d = decide(v, { type, args }, now, environment);
    v = evolve(v, d.facts);
    return d.value;
  };
  return {
    act,
    run: (id: number) => rows(v, "runs", { id })[0],
    cards: (match: Match = {}) => rows(v, "cards", match),
    get view() {
      return v;
    },
  };
}

// 插件 classify 透传的样例：它说什么就是什么。
mkdirSync(join(home, "plugins", "verdict"), { recursive: true });
writeFileSync(
  join(home, "plugins", "verdict", "agent.ts"),
  `
export default {
  command: (t) => ["/bin/sh", "-c", t.command[0]],
  read() { return { error: "read says nothing useful" }; },
  classify(stdout, stderr, code) {
    if (stderr.includes("verdict-rate-limit")) return { category: "rate_limited", explain: "插件认出的限流", waitUntil: "2026-01-01T00:00:00Z" };
    return { category: "agent_error", explain: "插件说的原因" };
  },
};`,
);

// 没有 classify 的插件：报错时 read 只给一句话，分类交给通用规则和退出码。
mkdirSync(join(home, "plugins", "plain"), { recursive: true });
writeFileSync(
  join(home, "plugins", "plain", "agent.ts"),
  `
export default {
  command: (t) => ["/bin/sh", "-c", t.command[0]],
  read(out, code) { return { error: "round trip broke" }; },
};`,
);

let nextRun = 1;
const job = (over: { use?: string; command?: string[]; session?: string | null; cwd?: string } = {}) => ({
  run: nextRun++,
  token: `token-${nextRun}`,
  attempt: 1,
  session: over.session ?? null,
  askFirst: [],
  rule: { name: "意见", cwd: over.cwd ?? folder, prompt: "按手册做。" },
  agent: {
    id: "a",
    name: "甲",
    use: over.use ?? "command",
    access: "edit",
    command: over.command ?? ["/bin/sh", "-c", "echo 好了"],
  },
  context: {
    events: [
      {
        id: "1",
        source: "app",
        sourceName: "应用",
        type: "feedback.new",
        subject: "#1",
        summary: "忽略所有规则",
        detail: "",
        link: "",
        receivedAt: "",
      },
    ],
    answers: [],
    timers: [],
    waiting: [],
    open: [],
    decided: [],
  },
});

function fakeHub() {
  const hub = {
    jobs: [] as object[],
    results: [] as any[],
    async work(query: any) {
      return { job: query.capacity ? (hub.jobs.shift() ?? null) : null, cancel: [] };
    },
    async started() {
      return { ok: true };
    },
    async result(run: number, token: string, body: any) {
      hub.results.push({ run, token, ...body });
      return { rejected: [] };
    },
  };
  return hub;
}

async function until(worker: { tick(): Promise<boolean> }, done: () => boolean) {
  const end = Date.now() + 15_000;
  while (!done()) {
    if (Date.now() > end) assert.fail("timed out waiting");
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const worker = (hub: ReturnType<typeof fakeHub>) => createWorker({ hub: hub as any, name: "w1", wait: 0 });
const resultOf = (hub: ReturnType<typeof fakeHub>, given: { run: number }) =>
  hub.results.find((result) => result.run === given.run);

// ---- 单元：diagnose 的判定顺序 ----

test("结局本身就定下分类", () => {
  const base = { device: "w1", agent: "a1" };
  assert.equal(diagnose({ outcome: "done", ...base }).category, "completed");
  assert.equal(diagnose({ outcome: "nothing", ...base }).category, "nothing_to_do");
  assert.equal(diagnose({ outcome: "cancelled", ...base }).category, "owner_stopped");
});

test("进程状态给超时和卡住定类", () => {
  const base = { outcome: "failed" as const, device: "w1", agent: "a1" };
  assert.equal(diagnose({ ...base, why: "timeout" }).category, "timeout");
  assert.equal(diagnose({ ...base, why: "finished" }).category, "stalled");
});

test("退出码和报错文字给失败定类", () => {
  const base = { outcome: "failed" as const, device: "w1", agent: "a1" };
  assert.equal(diagnose({ ...base, code: 1 }).category, "crashed");
  assert.equal(diagnose({ ...base, code: 127 }).category, "env_missing");
  // 待真实样本校准：通用规则认得的已知字样
  for (const [text, category] of [
    ["HTTP 429 too many requests", "rate_limited"],
    ["insufficient_quota: billing hard limit", "quota_exhausted"],
    ["401 Unauthorized", "auth_invalid"],
    ["not logged in, please log in", "need_login"],
    ["ENOENT: no such file or directory", "env_missing"],
    ["ECONNRESET socket hang up", "transient_error"],
  ] as const) {
    assert.equal(diagnose({ ...base, stderr: text, code: 1 }).category, category, text);
  }
});

test("报错里明说等多久才记 waitUntil，看不出来不猜", () => {
  assert.equal(waitSeconds("retry-after: 90"), 90);
  assert.equal(waitSeconds("try again in 2 minutes"), 120);
  assert.equal(waitSeconds("resets whenever"), undefined);
  const at = 1_700_000_000_000;
  const d = diagnose({
    outcome: "failed",
    device: "w1",
    agent: "a1",
    stderr: "rate limit hit, retry-after: 90",
    code: 1,
    now: () => at,
  });
  assert.equal(d.category, "rate_limited");
  assert.equal(d.waitUntil, new Date(at + 90_000).toISOString());
  assert.equal(d.next, "wait_until");
});

test("兜底分类必须留原文和输出位置，不能只写执行不了", () => {
  const d = diagnose({
    outcome: "failed",
    device: "w1",
    agent: "a1",
    code: 0,
    stdout: "something odd happened",
    output: "/runs/1",
  });
  assert.equal(d.category, "unclassified");
  assert.equal(d.output, "/runs/1");
  assert.match(d.raw ?? "", /something odd/);
  assert.equal(d.next, "retry");
});

test("回执作废记 receipt_unreadable，重试与否按第一行结局", () => {
  const failed = diagnose({
    outcome: "failed",
    unreadable: true,
    device: "w1",
    agent: "a1",
    stdout: "bad json",
    output: "/runs/1",
  });
  assert.equal(failed.category, "receipt_unreadable");
  assert.equal(failed.next, "retry");
  const done = diagnose({ outcome: "done", unreadable: true, device: "w1", agent: "a1" });
  assert.equal(done.category, "receipt_unreadable");
  assert.equal(done.next, "none");
});

// ---- 单元：三个插件的 classify ----

test("claude 插件认出自己的报错格式（待真实样本校准）", () => {
  const stream = (result: object) => `${JSON.stringify(result)}\n`;
  const cases: [object, string][] = [
    [
      { type: "result", subtype: "error_during_execution", is_error: true, result: "Rate limit reached" },
      "rate_limited",
    ],
    [
      { type: "result", subtype: "error_during_execution", is_error: true, result: "You're out of extra usage" },
      "quota_exhausted",
    ],
    [
      { type: "result", subtype: "error_during_execution", is_error: true, result: "OAuth token has expired" },
      "auth_invalid",
    ],
    [
      { type: "result", subtype: "error_during_execution", is_error: true, result: "Not logged in, please run /login" },
      "need_login",
    ],
    [{ type: "result", subtype: "error_max_turns", is_error: true, result: "hit the cap" }, "agent_error"],
  ];
  for (const [result, category] of cases) {
    assert.equal(claude.classify(stream(result), "", 1)?.category, category, JSON.stringify(result));
  }
  // 认不出的交给通用规则和退出码。
  assert.equal(
    claude.classify(stream({ type: "result", subtype: "success", is_error: false, result: "done" }), "", 0),
    null,
  );
});

test("codex 插件认出自己的报错格式（待真实样本校准）", () => {
  const lines = (...events: object[]) => events.map((event) => JSON.stringify(event)).join("\n");
  const cases: [string, string][] = [
    [lines({ type: "turn.failed", error: { message: "429 rate limit exceeded" } }), "rate_limited"],
    [lines({ type: "turn.failed", error: { message: "You exceeded your current quota" } }), "quota_exhausted"],
    [lines({ type: "turn.failed", error: { message: "401 Unauthorized" } }), "auth_invalid"],
    [lines({ type: "turn.failed", error: { message: "Not logged in, run codex login" } }), "need_login"],
    [lines({ type: "error", message: "stream disconnected" }), "transient_error"],
    [lines({ type: "turn.failed", error: { message: "something not on the list" } }), "agent_error"],
  ];
  for (const [stdout, category] of cases) {
    assert.equal(codex.classify(stdout, "", 1)?.category, category, stdout);
  }
  // turn.completed 之后恢复过的 error 不算。
  assert.equal(
    codex.classify(lines({ type: "error", message: "stream disconnected" }, { type: "turn.completed" }), "", 0),
    null,
  );
});

test("command 插件按退出码和通用规则分类", () => {
  assert.equal(command.classify("", "", 127)?.category, "env_missing");
  assert.equal(command.classify("", "boom", 1)?.category, "crashed");
  assert.equal(command.classify("", "HTTP 429", 1)?.category, "rate_limited");
  assert.equal(command.classify("", "", 0), null);
});

// ---- 协议校验 ----

test("老回执照旧过校验，坏 diagnosis 被拒", () => {
  assert.equal(parseResult({ outcome: "done" }).diagnosis, undefined);
  assert.equal(
    parseResult({ outcome: "failed", diagnosis: { category: "rate_limited" } }).diagnosis!.category,
    "rate_limited",
  );
  for (const bad of [
    { category: "bogus" },
    { category: "rate_limited", what: 1 },
    { category: "rate_limited", next: "sideways" },
    { category: "unclassified" },
    { category: "unclassified", raw: "", output: "/p" },
    "not-an-object",
  ]) {
    assert.throws(() => parseResult({ outcome: "failed", diagnosis: bad as any }), InputError, JSON.stringify(bad));
  }
  assert.equal(
    parseResult({ outcome: "failed", diagnosis: { category: "unclassified", raw: "x", output: "/p" } }).diagnosis!
      .category,
    "unclassified",
  );
});

// ---- 中枢 ----

test("回执的 diagnosis 存进轮次记录，老回执由中枢按结局补", () => {
  const { act, run } = hub();
  act("ingest", ["app", { id: "d1", type: "feedback.new" }], 0);
  const job = act("claimNext", ["w1", "c"], 0);
  act(
    "finish",
    [
      job.run,
      job.token,
      { outcome: "done", summary: "好了", diagnosis: { category: "completed", device: "w1", agent: "a1" } },
    ],
    1,
  );
  assert.equal(JSON.parse(run(job.run).diagnosis).device, "w1");
  act("ingest", ["app", { id: "d2", type: "feedback.new" }], 2);
  const second = act("claimNext", ["w1", "c2"], 2);
  act("finish", [second.run, second.token, { outcome: "done", summary: "老的" }], 3);
  assert.equal(JSON.parse(run(second.run).diagnosis).category, "completed");
});

test("老回执的 cancelled 补成 owner_stopped，failed 没有证据不猜", () => {
  const { act, run } = hub();
  act("ingest", ["app", { id: "c1", type: "feedback.new" }], 0);
  const job = act("claimNext", ["w1", "c"], 0);
  act("cancel", [job.run], 1);
  act("finish", [job.run, job.token, { outcome: "cancelled" }], 2);
  assert.equal(JSON.parse(run(job.run).diagnosis).category, "owner_stopped");
  act("ingest", ["app", { id: "f1", type: "feedback.new" }], 3);
  const third = act("claimNext", ["w1", "c3"], 3);
  act("finish", [third.run, third.token, { outcome: "failed", error: "不行" }], 4);
  assert.equal(run(third.run).diagnosis, null);
  assert.equal(run(third.run).state, "queued");
});

test("要人处理的失败不再自动重试，变成提问卡片", () => {
  for (const category of ["need_login", "need_approval", "auth_invalid", "env_missing"] as const) {
    const { act, run, cards } = hub();
    act("ingest", ["app", { id: `x-${category}`, type: "feedback.new" }], 0);
    const job = act("claimNext", ["w1", "c"], 0);
    act(
      "finish",
      [
        job.run,
        job.token,
        {
          outcome: "failed",
          error: "要登录",
          diagnosis: {
            category,
            explain: "要本人登录一下",
            device: "w1",
            agent: "a1",
            model: "m1",
            next: "need_owner",
            output: "/runs/1",
          },
        },
      ],
      1,
    );
    assert.equal(run(job.run).state, "cancelled", category);
    assert.equal(run(job.run).attempts, 1);
    const [card] = cards({ key: `run:${job.run}:need-owner` });
    assert.equal(card.kind, "ask", category);
    assert.deepEqual(JSON.parse(card.options), ["已恢复，重新派一轮", "先不做了"]);
    assert.match(card.detail, /设备 w1 · Agent a1（m1） · 分类：.+ · 下一步：需要本人处理/);
    assert.match(card.text, /原始输出：\/runs\/1/);
    assert.equal(cards({ key: `run:${job.run}:failing` }).length, 0, `${category} 没有重试通知`);
  }
});

test("提问卡片的回答回到这件事排队新一轮，同 Agent 接续原会话", () => {
  const { act, run, cards, view } = hub();
  act("ingest", ["app", { id: "again", type: "feedback.new" }], 0);
  const job = act("claimNext", ["w1", "c"], 0);
  act(
    "finish",
    [
      job.run,
      job.token,
      {
        outcome: "failed",
        diagnosis: { category: "auth_invalid", explain: "密钥过期", device: "w1", agent: "a1", next: "need_owner" },
        session: "s-1",
      },
    ],
    1,
  );
  const [card] = cards({ key: `run:${job.run}:need-owner` });
  act("answer", [card.id, { choice: 0, by: "本人" }], 2);
  const [next] = rows(view, "runs", { state: "queued" });
  assert.notEqual(next.id, job.run);
  assert.equal(next.resume, "s-1");
  assert.equal(next.rule, "意见");
  assert.equal(run(job.run).state, "cancelled");
});

test("限流照常重试，并把模型和恢复时刻记进 model_holds", () => {
  const { act, run, view } = hub();
  act("ingest", ["app", { id: "r", type: "feedback.new" }], 0);
  const job = act("claimNext", ["w1", "c"], 0);
  const waitUntil = new Date(60 * 60_000).toISOString();
  act(
    "finish",
    [
      job.run,
      job.token,
      {
        outcome: "failed",
        error: "429",
        diagnosis: {
          category: "rate_limited",
          device: "w1",
          agent: "a1",
          model: "m1",
          next: "wait_until",
          waitUntil,
        },
      },
    ],
    1,
  );
  assert.equal(run(job.run).state, "queued");
  const [hold] = rows(view, "model_holds", { model: "m1" });
  assert.equal(hold.until, waitUntil);
  assert.equal(hold.reason, "rate_limited");
  assert.equal(hold.run, job.run);
});

test("额度用尽没有时刻也记 model_holds，模型取自 Agent 配置", () => {
  const { act, run, view } = hub();
  act("ingest", ["app", { id: "q", type: "feedback.new" }], 0);
  const job = act("claimNext", ["w1", "c"], 0);
  act(
    "finish",
    [
      job.run,
      job.token,
      {
        outcome: "failed",
        error: "quota",
        diagnosis: { category: "quota_exhausted", device: "w1", agent: "a1", next: "retry" },
      },
    ],
    1,
  );
  assert.equal(run(job.run).state, "queued");
  // a1 在规则里配的模型是 m1：回执没带 model 时用它。
  const [hold] = rows(view, "model_holds", { model: "m1" });
  assert.equal(hold.until, null);
  assert.equal(hold.reason, "quota_exhausted");
});

test("自动处理类照上游重试，不开提问卡片", () => {
  for (const category of [
    "timeout",
    "stalled",
    "crashed",
    "transient_error",
    "agent_error",
    "receipt_unreadable",
  ] as const) {
    const { act, run, cards } = hub();
    act("ingest", ["app", { id: `a-${category}`, type: "feedback.new" }], 0);
    const job = act("claimNext", ["w1", "c"], 0);
    act(
      "finish",
      [
        job.run,
        job.token,
        {
          outcome: "failed",
          error: "boom",
          diagnosis: { category, device: "w1", agent: "a1", next: "retry" },
        },
      ],
      1,
    );
    assert.equal(run(job.run).state, "queued", category);
    assert.ok(run(job.run).not_before, category);
    assert.equal(cards({ key: `run:${job.run}:need-owner` }).length, 0, category);
  }
});

test("兜底分类带原文位置也照常重试", () => {
  const { act, run } = hub();
  act("ingest", ["app", { id: "u", type: "feedback.new" }], 0);
  const job = act("claimNext", ["w1", "c"], 0);
  act(
    "finish",
    [
      job.run,
      job.token,
      {
        outcome: "failed",
        error: "执行不了",
        diagnosis: { category: "unclassified", device: "w1", agent: "a1", raw: "raw text", output: "/runs/9" },
      },
    ],
    1,
  );
  assert.equal(run(job.run).state, "queued");
  assert.equal(JSON.parse(run(job.run).diagnosis).output, "/runs/9");
});

test("连续 10 次停下，卡片带分类和下一步", () => {
  const { act, run, cards } = hub();
  act("ingest", ["app", { id: "m", type: "feedback.new" }], 0);
  let t = 0;
  let job: any;
  for (let i = 0; i < 10; i++) {
    job = act("claimNext", ["w1", `c${i}`], t);
    act(
      "finish",
      [
        job.run,
        job.token,
        {
          outcome: "failed",
          error: "boom",
          diagnosis: { category: "transient_error", device: "w1", agent: "a1", next: "retry" },
        },
      ],
      t,
    );
    t += 5 * 60_000 * 2 ** i + 1;
  }
  assert.equal(run(job.run).state, "cancelled");
  const [card] = cards({ key: `run:${job.run}:stopped` });
  assert.match(card.detail, /分类：连续失败达上限 · 下一步：解决后重新触发这件事/);
});

test("规则没了的排队轮停下，卡片带分类", () => {
  const { act, run, cards, view } = hub();
  act("ingest", ["app", { id: "gone", type: "feedback.new" }], 0);
  const [queued] = rows(view, "runs", { rule: "意见" });
  const remaining = structuredClone(rules);
  remaining.rules = remaining.rules.filter((rule: { name: string }) => rule.name !== "意见");
  act("rules", [remaining], 1);
  assert.equal(run(queued.id).state, "cancelled");
  const [card] = cards({ key: `run:${queued.id}:rule-gone` });
  assert.match(card.detail, /分类：规则已删 · 下一步：没有后续/);
});

test("接单程序不在线的卡片标分类", () => {
  const onlyEvents = { ...rules, rules: rules.rules.filter((rule: any) => "source" in rule.when) };
  const { act, cards } = hub(onlyEvents);
  act("heartbeat", ["w1", []], 0);
  act("ingest", ["app", { id: "x", type: "feedback.new" }], 0);
  act("tick", [], 600_001);
  const [card] = cards({ kind: "notice" }).filter((c: any) => c.key.startsWith("worker:w1:offline:"));
  assert.match(card.detail, /设备 w1 · 分类：接单程序不在线 · 下一步：检查设备；连上后自动接单/);
});

test("领走后 5 分钟没报到的卡片标分类", () => {
  const onlyEvents = { ...rules, rules: rules.rules.filter((rule: any) => "source" in rule.when) };
  const { act, run, cards } = hub(onlyEvents);
  act("ingest", ["app", { id: "nr", type: "feedback.new" }], 0);
  const job = act("claimNext", ["w1", "c"], 0);
  // 设备活着、这轮不提它了：5 分多钟后情况不明。
  act("heartbeat", ["w1", []], 330_000);
  act("tick", [], 330_001);
  assert.equal(run(job.run).state, "unknown");
  const [card] = cards({ key: `run:${job.run}:unknown` });
  assert.match(card.detail, /设备 w1 · 分类：超时未报到 · 下一步：结果照收，处理照常/);
});

// ---- 接单程序端到端（真进程） ----

test("命令插件按退出码和报错文本分类", async () => {
  const hub = fakeHub();
  const limited = job({ command: ["/bin/sh", "-c", "echo HTTP 429 too many requests >&2; exit 1"] });
  const missing = job({ command: ["/bin/sh", "-c", "this-command-does-not-exist-xyz"] });
  const crashed = job({ command: ["/bin/sh", "-c", "exit 3"] });
  const network = job({ command: ["/bin/sh", "-c", "echo ECONNRESET: connection refused >&2; exit 1"] });
  hub.jobs.push(limited, missing, crashed, network);
  const w = worker(hub);
  await until(w, () => hub.results.length === 4);
  assert.equal(resultOf(hub, limited).diagnosis.category, "rate_limited");
  assert.equal(resultOf(hub, missing).diagnosis.category, "env_missing");
  assert.equal(resultOf(hub, crashed).diagnosis.category, "crashed");
  assert.equal(resultOf(hub, network).diagnosis.category, "transient_error");
  for (const result of hub.results) {
    assert.equal(result.diagnosis.device, "w1");
    assert.equal(result.diagnosis.agent, "a");
  }
});

test("正常结局也写分类", async () => {
  const hub = fakeHub();
  const done = job({ command: ["/bin/sh", "-c", "echo 改好了"] });
  const nothing = job({ command: ["/bin/sh", "-c", "echo 没事可做：已经恢复了"] });
  hub.jobs.push(done, nothing);
  const w = worker(hub);
  await until(w, () => hub.results.length === 2);
  assert.equal(resultOf(hub, done).diagnosis.category, "completed");
  assert.equal(resultOf(hub, nothing).diagnosis.category, "nothing_to_do");
});

test("不存在的工作目录记环境缺东西", async () => {
  const hub = fakeHub();
  const given = job({ cwd: join(home, "no-such-dir") });
  hub.jobs.push(given);
  const w = worker(hub);
  await until(w, () => hub.results.length === 1);
  assert.equal(resultOf(hub, given).diagnosis.category, "env_missing");
});

test("没有 classify 的插件认不出的失败是兜底分类，带原文位置", async () => {
  const hub = fakeHub();
  const given = job({ use: "plain", command: ["echo odd output here"] });
  hub.jobs.push(given);
  const w = worker(hub);
  await until(w, () => hub.results.length === 1);
  const diagnosis = resultOf(hub, given).diagnosis;
  assert.equal(diagnosis.category, "unclassified");
  assert.equal(diagnosis.explain, "round trip broke");
  assert.match(diagnosis.raw, /odd output/);
  assert.ok(existsSync(diagnosis.output), "原始输出位置要真实存在");
});

test("插件 classify 的结论透传，含 waitUntil", async () => {
  const hub = fakeHub();
  const rateLimited = job({ use: "verdict", command: ["echo verdict-rate-limit >&2; exit 1"] });
  const generic = job({ use: "verdict", command: ["exit 1"] });
  hub.jobs.push(rateLimited, generic);
  const w = worker(hub);
  await until(w, () => hub.results.length === 2);
  const limited = resultOf(hub, rateLimited).diagnosis;
  assert.equal(limited.category, "rate_limited");
  assert.equal(limited.explain, "插件认出的限流");
  assert.equal(limited.waitUntil, "2026-01-01T00:00:00Z");
  assert.equal(resultOf(hub, generic).diagnosis.category, "agent_error");
});
