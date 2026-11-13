// The usage doors. Failure cases: a report with a made-up date, a name holding the key separator, a negative or fractional
// counter, a quota past 100% or a reset without a zone is written to the log; a report re-sent after its answer was lost
// counts the day twice; a day the worker didn't mention is wiped out with the one it sent; one device's quota snapshot
// erases another's; a worker's key reads the owner's view or the owner's writes the report; a dispatched run's usage is
// left out of the view or counted to the wrong device; a metered row's cache is added to its input on top of input that
// already has it in, doubling the spend.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { setup } from "./helpers.ts";

setup("usage");
const hub = await import("./hub.ts");
const { serve } = await import("../host/http.ts");
const { parseUsageReport } = await import("../protocol/validate.ts");

const keys = {
  source: hub.addKey("source", "app"),
  w1: hub.addKey("worker", "w1"),
  w2: hub.addKey("worker", "w2"),
  owner: hub.addKey("owner", "owner"),
};
const server = serve(0, "127.0.0.1", { commit: "test" });
let base = "";
before(async () => {
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  for (const table of ["usage", "quotas", "events", "runs", "run_events", "seen"] as const) hub.fixtureClear(table);
});

async function call(path: string, { key, body }: { key?: string; body?: unknown } = {}) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(key && { authorization: `Bearer ${key}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

const dayOf = (ms: number) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ms);
const DAY = dayOf(Date.now());
const YESTERDAY = dayOf(Date.now() - 86400_000);
const row = (agent: string, model: string, source: string, counters = {}) => ({
  agent,
  model,
  source,
  input: 10,
  output: 5,
  cache_read: 2,
  cache_write: 3,
  runs: 1,
  ...counters,
});
const day = (date: string, rows: object[]) => ({ date, rows });
const report = (body: object) => call("/v1/usage", { key: keys.w1, body });
const usage = (query = "") => call(`/v1/usage${query}`, { key: keys.owner });

test("a report is checked at the door: real dates, clean names, whole counters", () => {
  const bad = (body: unknown) => assert.throws(() => parseUsageReport(body));
  bad(null);
  bad({ days: [], extra: 1 });
  bad({ days: [{ date: DAY.slice(0, 5) + "13-01", rows: [] }] });
  bad({ days: [{ date: DAY.slice(0, 5) + "02-30", rows: [] }] });
  bad({ days: [{ date: "11-13", rows: [] }] });
  bad({ days: [{ date: DAY, rows: [{ ...row("a", "m", "gateway"), junk: 1 }] }] });
  bad({ days: [{ date: DAY, rows: [row("a|b", "m", "gateway")] }] });
  bad({ days: [{ date: DAY, rows: [row("a", "m", "gateway", { input: -1 })] }] });
  bad({ days: [{ date: DAY, rows: [row("a", "m", "gateway", { input: 1.5 })] }] });
  bad({ days: Array.from({ length: 63 }, () => day(DAY, [])) });
  bad({ days: [{ date: DAY, rows: Array.from({ length: 201 }, () => row("a", "m", "s")) }] });
  bad({ quotas: [{ provider: "p", account: "", window: "w", used_pct: 101, resets_at: "2026-11-14T00:00:00Z" }] });
  bad({ quotas: [{ provider: "p", account: "", window: "w", used_pct: 10, resets_at: "2026-11-14" }] });
  parseUsageReport({ days: [day(DAY, [row("a", "m", "gateway")])] });
  parseUsageReport({
    quotas: [{ provider: "p", account: "me", window: "5 hours", used_pct: 0, resets_at: "2026-11-14T00:00:00+08:00" }],
  });
  parseUsageReport({});
});

test("the doors take a worker's report and an owner's reading, and no other key crosses", async () => {
  assert.equal((await call("/v1/usage")).status, 401);
  assert.equal((await call("/v1/usage", { key: keys.owner, body: {} })).status, 401);
  assert.equal((await call("/v1/usage", { key: "made-up", body: {} })).status, 401);
  assert.equal((await call("/v1/usage?days=7")).status, 401);
  assert.equal((await usage("?days=7")).status, 200);
  assert.equal((await call("/v1/usage?days=7", { key: keys.w1 })).status, 401);
  assert.equal((await report({ days: [] })).status, 200);
  assert.equal((await usage("?days=0")).status, 400);
  assert.equal((await usage("?days=94")).status, 400);
  assert.equal((await usage("?days=two")).status, 400);
});

test("a day re-reported replaces itself whole, and days not mentioned are left alone", async () => {
  const first = {
    days: [day(DAY, [row("a1", "m1", "gateway", { input: 100 })]), day(YESTERDAY, [row("a1", "m1", "sessions")])],
  };
  assert.equal((await report(first)).status, 200);
  assert.equal((await report(first)).status, 200);
  let view = (await usage("?days=30")).json;
  let today = view.days.find((d: any) => d.date === DAY);
  assert.equal(today.devices.w1.input, 105); // input 100 + cache 2 + 3
  // The same day said again, differently: the old reading is gone, not added to.
  await report({ days: [day(DAY, [row("a1", "m1", "gateway", { input: 50 })])] });
  view = (await usage("?days=30")).json;
  today = view.days.find((d: any) => d.date === DAY);
  assert.equal(today.devices.w1.input, 55);
  assert.equal(view.devices.w1.runs, today.devices.w1.runs + 1); // 11-12's row was kept
  const yesterday = view.days.find((d: any) => d.date === YESTERDAY);
  assert.equal(yesterday.devices.w1.runs, 1);
});

test("a worker's quotas replace its own and no one else's", async () => {
  const quota = (used: number) => ({
    quotas: [
      {
        provider: "p",
        account: "me",
        plan: "plus",
        window: "5 hours",
        used_pct: used,
        resets_at: "2026-11-14T00:00:00Z",
      },
    ],
  });
  await call("/v1/usage", { key: keys.w2, body: quota(50) });
  await report(quota(10));
  await report(quota(80));
  const view = (await usage()).json;
  const mine = view.quotas.filter((q: any) => q.device === "w1");
  assert.equal(mine.length, 1);
  assert.equal(mine[0].used_pct, 80);
  assert.equal(mine[0].plan, "plus");
  assert.equal(view.quotas.find((q: any) => q.device === "w2").used_pct, 50);
  // An empty snapshot is a snapshot too: it clears what was there.
  await report({ quotas: [] });
  assert.equal((await usage()).json.quotas.filter((q: any) => q.device === "w1").length, 0);
});

test("the view adds a run's receipt under source runs, to its worker's device", async () => {
  hub.ingest("app", { id: "use-1", type: "feedback.new", subject: "#1" });
  const job = hub.claimNext("w1", "c1");
  hub.finish(job!.run, job!.token, {
    outcome: "done",
    summary: "做完了",
    usage: { input: 1000, output: 100, cached: 400, cost: 0.01 },
  });
  await report({ days: [day(DAY, [row("a1", "m1", "gateway", { input: 100 })])] });
  const view = (await usage("?days=30&device=w1")).json;
  const runsRow = view.rows.find((r: any) => r.source === "runs");
  assert.equal(runsRow.agent, "a1");
  assert.equal(runsRow.model, "m1");
  assert.equal(runsRow.device, "w1");
  assert.equal(runsRow.date, view.until);
  // The run's input already held its cache; the metered row's didn't. Both read in the same all-in total.
  assert.equal(view.devices.w1.input, 1000 + 105);
  assert.equal(view.devices.w1.cached, 400 + 2);
  assert.equal(view.devices.w1.runs, 2);
  // Another device asked alone doesn't see it.
  const other = (await usage("?days=30&device=w2")).json;
  assert.equal(other.total.runs, 0);
});

test("state carries today's and the week's usage next to spending", async () => {
  await report({ days: [day(DAY, [row("a1", "m1", "gateway", { input: 100 })])] });
  const state = (await call("/v1/state", { key: keys.owner })).json;
  assert.ok(state.usage.today.devices.w1.input > 0 || Object.keys(state.usage.week.devices).length > 0);
  assert.deepEqual(Object.keys(state.usage).sort(), ["quotas", "today", "week"]);
  assert.ok(state.spending);
});
