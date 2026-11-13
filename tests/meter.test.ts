// The worker's meter. Failure cases: a gateway line appended between scans is missed or counted twice; a half-written
// last line is parsed and the offset loses a line; a file that shrank is read from where it was; a session this worker
// itself launched is counted on top of its run's receipt, charging it twice; a cumulative counter is reported as one
// request's spend; a quota file's windows are skipped or a stale one is sent as fresh; a restart sends the same days
// again, and the hub's whole-day replace makes that a retry, not a double.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("meter");
const { createMeter } = await import("../worker/meter.ts");
const STATE_FILE = join(home, "worker", "metering.json");
// Each test meters a fresh machine; the restart test shares one state on purpose.
beforeEach(() => rmSync(STATE_FILE, { force: true }));

const pad = (n: number) => String(n).padStart(2, "0");
const dayOf = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const TODAY = dayOf(Date.now());
const stamp = new Date().toISOString();

const files = join(home, "meter-files");
mkdirSync(files, { recursive: true });

function watch(sources: object[]) {
  const sent: any[] = [];
  const meter = createMeter({
    send: async (body) => {
      sent.push(body);
      return { ok: true };
    },
    sources: sources as any,
    now: () => moment,
  });
  return { sent, meter };
}
let moment = 0;
const MINUTE = 60_000;
/** A scan every 15s, a send every 60s: this tick does both. */
const tickAfter = (ms: number) => (moment += ms);

test("gateway lines are counted once, by day and agent and model", async () => {
  const file = join(files, "gw.jsonl");
  const entry = (input: number) =>
    JSON.stringify({
      t: stamp,
      agent: "a1",
      provider: "p",
      model: "m1",
      req: "r",
      in: input,
      out: 5,
      cache_read: 2,
      cache_write: 3,
      ms: 1,
    });
  writeFileSync(file, `${entry(10)}\n${entry(20)}\n`);
  const { sent, meter } = watch([{ kind: "gateway", file }]);
  tickAfter(2 * MINUTE);
  await meter.tick();
  assert.equal(sent.length, 1);
  const rows = sent[0].days.find((d: any) => d.date === TODAY).rows;
  assert.deepEqual(rows, [
    { agent: "a1", model: "m1", source: "gateway", input: 30, output: 10, cache_read: 4, cache_write: 6, runs: 2 },
  ]);
  // More arrives: the next report is the same day in full, not a delta.
  appendFileSync(file, `${entry(5)}\n`);
  tickAfter(MINUTE);
  await meter.tick();
  assert.equal(sent.length, 2);
  const again = sent[1].days.find((d: any) => d.date === TODAY).rows[0];
  assert.equal(again.input, 35);
  assert.equal(again.runs, 3);
});

test("a gateway line with an empty agent or model is counted under ?", async () => {
  const file = join(files, "gw.jsonl");
  writeFileSync(
    file,
    `${JSON.stringify({ t: stamp, agent: "", model: "", in: 1, out: 1 })}\n` +
      `${JSON.stringify({ t: stamp, agent: "a1", in: 2, out: 1 })}\n`,
  );
  const { sent, meter } = watch([{ kind: "gateway", file }]);
  tickAfter(2 * MINUTE);
  await meter.tick();
  assert.equal(sent.length, 1);
  const rows = sent[0].days.find((d: any) => d.date === TODAY).rows;
  assert.deepEqual(rows, [
    { agent: "?", model: "?", source: "gateway", input: 1, output: 1, cache_read: 0, cache_write: 0, runs: 1 },
    { agent: "a1", model: "?", source: "gateway", input: 2, output: 1, cache_read: 0, cache_write: 0, runs: 1 },
  ]);
});

test("days saved with an empty-name key report it folded into ?", async () => {
  mkdirSync(join(home, "worker"), { recursive: true });
  writeFileSync(
    STATE_FILE,
    JSON.stringify({
      files: {},
      sessions: {},
      dirty: [TODAY],
      days: {
        [TODAY]: {
          "a1||gateway": { input: 1, output: 1, cache_read: 0, cache_write: 0, runs: 1 },
          "a1|?|gateway": { input: 2, output: 2, cache_read: 0, cache_write: 0, runs: 1 },
        },
      },
    }),
  );
  const { sent, meter } = watch([]);
  tickAfter(2 * MINUTE);
  await meter.tick();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].days, [
    {
      date: TODAY,
      rows: [
        { agent: "a1", model: "?", source: "gateway", input: 3, output: 3, cache_read: 0, cache_write: 0, runs: 2 },
      ],
    },
  ]);
});

test("a line half-written is read when its rest arrives", async () => {
  const file = join(files, "gw-half.jsonl");
  writeFileSync(file, `${JSON.stringify({ t: stamp, agent: "a1", model: "m1", in: 1, out: 1 })}`.slice(0, 20));
  const { sent, meter } = watch([{ kind: "gateway", file }]);
  tickAfter(MINUTE);
  await meter.tick();
  assert.equal(sent.length, 0);
  appendFileSync(
    file,
    `xxxx":true}\n${JSON.stringify({ t: stamp, agent: "a2", model: "m2", in: 7, out: 3, cache_read: 0, cache_write: 0 })}\n`,
  );
  tickAfter(MINUTE);
  await meter.tick();
  const rows = sent.at(-1).days.find((d: any) => d.date === TODAY).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].input, 7);
});

test("session files count every agent's usage, and a launched session is left out", async () => {
  const dir = join(files, "claude-sessions");
  mkdirSync(dir, { recursive: true });
  const launchedId = "11111111-2222-3333-4444-555555555555";
  const otherId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const message = (input: number) =>
    JSON.stringify({
      timestamp: stamp,
      message: {
        model: "m9",
        usage: { input_tokens: input, output_tokens: 2, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 },
      },
    });
  writeFileSync(join(dir, `${launchedId}.jsonl`), `${message(999)}\n`);
  writeFileSync(join(dir, `${otherId}.jsonl`), `${message(40)}\n`);
  const codeDir = join(files, "codex-sessions");
  mkdirSync(codeDir, { recursive: true });
  writeFileSync(
    join(codeDir, "rollout-2026-11-13T10-00-00-cccccccc-dddd-eeee-ffff-000000000000.jsonl"),
    `${JSON.stringify({ timestamp: stamp, type: "turn_context", payload: { model: "m8" } })}\n` +
      `${JSON.stringify({ timestamp: stamp, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 40 } } } })}\n` +
      `${JSON.stringify({ timestamp: stamp, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 150, output_tokens: 15, cached_input_tokens: 40 } } } })}\n`,
  );
  const { sent, meter } = watch([
    { kind: "sessions", agent: "claude", use: "claude", dir },
    { kind: "sessions", agent: "codex", use: "codex", dir: codeDir },
  ]);
  meter.launched("claude", launchedId);
  tickAfter(MINUTE);
  await meter.tick();
  const rows = sent.at(-1).days.find((d: any) => d.date === TODAY).rows;
  const claude = rows.find((r: any) => r.agent === "claude");
  assert.equal(claude.input, 40);
  assert.equal(rows.filter((r: any) => r.agent === "claude").length, 1);
  const codex = rows.find((r: any) => r.agent === "codex");
  assert.equal(codex.model, "m8");
  // Cumulative totals became per-request spend: 100 then 50 more, cached 40 of the first.
  assert.equal(codex.input + codex.cache_read, 150);
  assert.equal(codex.cache_read, 40);
  assert.equal(codex.output, 15);
});

test("a quota file's windows ride along, refreshed when it changes", async () => {
  const file = join(files, "quotas.json");
  const snap = (used: number) =>
    JSON.stringify({
      "prov|plus": {
        quota: {
          provider: "prov",
          plan: "plus",
          windows: [{ name: "5 hours", used, resetsAt: "2026-11-14T01:00:00Z" }],
        },
        at: "2026-11-13T20:00:00Z",
      },
    });
  writeFileSync(file, snap(10));
  const { sent, meter } = watch([{ kind: "quota", file }]);
  tickAfter(MINUTE);
  await meter.tick();
  assert.deepEqual(sent.at(-1).quotas, [
    {
      provider: "prov",
      account: "plus",
      plan: "plus",
      window: "5 hours",
      used_pct: 10,
      resets_at: "2026-11-14T01:00:00Z",
      at: "2026-11-13T20:00:00Z",
    },
  ]);
  writeFileSync(file, snap(55));
  tickAfter(MINUTE);
  await meter.tick();
  assert.equal(sent.at(-1).quotas[0].used_pct, 55);
});

test("a quota history reads the freshest sample of each window", async () => {
  const file = join(files, "quota-history.json");
  writeFileSync(
    file,
    JSON.stringify({
      "prov|me": {
        "5 hours": [
          { at: "2026-11-13T01:00:00Z", left: 80, resetsAt: "2026-11-13T06:00:00Z" },
          { at: "2026-11-13T02:00:00Z", left: 35, resetsAt: "2026-11-13T06:00:00Z" },
        ],
        "7 days": [{ at: "2026-11-13T02:00:00Z", left: 92, resetsAt: "2026-11-20T00:00:00Z" }],
      },
    }),
  );
  const { sent, meter } = watch([{ kind: "quota", file }]);
  tickAfter(MINUTE);
  await meter.tick();
  assert.deepEqual(sent.at(-1).quotas, [
    {
      provider: "prov",
      account: "me",
      window: "5 hours",
      used_pct: 65,
      resets_at: "2026-11-13T06:00:00Z",
      at: "2026-11-13T02:00:00Z",
    },
    {
      provider: "prov",
      account: "me",
      window: "7 days",
      used_pct: 8,
      resets_at: "2026-11-20T00:00:00Z",
      at: "2026-11-13T02:00:00Z",
    },
  ]);
});

test("a gateway line for a session this worker launched isn't counted again", async () => {
  const file = join(files, "gw-runs.jsonl");
  const launched = "99999999-8888-7777-6666-555555555555";
  writeFileSync(
    file,
    `${JSON.stringify({ t: stamp, agent: "claude", model: "m1", session: launched, in: 900, out: 9 })}\n` +
      `${JSON.stringify({ t: stamp, agent: "claude", model: "m1", session: "someone-elses", in: 10, out: 1 })}\n`,
  );
  const { sent, meter } = watch([{ kind: "gateway", file }]);
  meter.launched("claude", launched);
  tickAfter(MINUTE);
  await meter.tick();
  const rows = sent.at(-1).days.find((d: any) => d.date === TODAY).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].input, 10);
});

test("a restart keeps what was sent: nothing is reported twice", async () => {
  const file = join(files, "gw-restart.jsonl");
  writeFileSync(file, `${JSON.stringify({ t: stamp, agent: "a1", model: "m1", in: 10, out: 1 })}\n`);
  const first = watch([{ kind: "gateway", file }]);
  tickAfter(MINUTE);
  await first.meter.tick();
  assert.equal(first.sent.length, 1);
  // A second meter over the same state sends nothing until the file moves.
  const second = watch([{ kind: "gateway", file }]);
  tickAfter(MINUTE);
  await second.meter.tick();
  assert.equal(second.sent.length, 0);
  appendFileSync(file, `${JSON.stringify({ t: stamp, agent: "a1", model: "m1", in: 5, out: 1 })}\n`);
  tickAfter(MINUTE);
  await second.meter.tick();
  assert.equal(second.sent.length, 1);
  assert.equal(second.sent[0].days[0].rows[0].input, 15);
});
