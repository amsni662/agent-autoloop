// Failure cases: a job carrying an archive pointer not leaving the archive where the agent can read it; a second job
// at the same version re-reading it over the wire; the hub away leaving the run without anything to read when a
// usable copy (or a stale one, marked as such) sits in this device's cache; a torn download standing in as a good one.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("archive-worker");
const folder = join(home, "project");
mkdirSync(folder);
const { createWorker } = await import("../worker/worker.ts");

let nextRun = 1;
const job = (archive?: object) => ({
  run: nextRun++,
  token: `token-${nextRun}`,
  attempt: 1,
  session: null,
  askFirst: [],
  rule: { name: "项目活", cwd: folder, prompt: "干活" },
  agent: {
    id: "a",
    name: "甲",
    use: "command",
    access: "edit",
    command: [
      process.execPath,
      "-e",
      `const fs=require("fs");const a=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).archive||{};
       if(!a.path){console.log("做完了 没有副本 v"+a.version+" stale="+a.stale)}
       else{const s=fs.readFileSync(a.path+"/状态.md","utf8").trim();console.log("做完了 "+s)}`,
      "{context}",
    ],
  },
  context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
  ...(archive && { archive }),
});

const content = (version: number) => ({
  project: "proj",
  version,
  commit: `head-${version}`,
  updatedAt: "",
  manual: `说明书 v${version}`,
  status: `状态 v${version}`,
  log: `日志 v${version}`,
  decisions: `决定 v${version}`,
  checkpoints: [],
  summary: `摘要 v${version}`,
});

function fakeHub() {
  const hub = {
    jobs: [] as object[],
    results: [] as any[],
    calls: [] as any[],
    down: false,
    async work(query: any) {
      return { job: query.capacity ? (hub.jobs.shift() ?? null) : null, cancel: [] };
    },
    async started() {
      return { ok: true };
    },
    async result(run: number, token: string, body: any) {
      hub.results.push({ run, ...body });
      return { rejected: [] };
    },
    async archive(project: string, version?: number) {
      hub.calls.push([project, version]);
      if (hub.down) throw new Error("connect ECONNREFUSED");
      return content(version ?? 9);
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

const contextOf = (run: number) =>
  JSON.parse(readFileSync(join(home, "worker", "runs", `${run}-1`, "context.json"), "utf8"));

test("a job's archive is materialized where the agent can read it, and the context says where", async () => {
  const hub = fakeHub();
  hub.jobs.push(job({ project: "proj", address: "archive/proj", version: 2, summary: "" }));
  const w = createWorker({ hub: hub as any, name: "w1", wait: 0 });
  await until(w, () => hub.results.length === 1);
  assert.deepEqual(hub.calls, [["proj", 2]]);
  const dir = join(home, "worker", "archives", "proj");
  assert.equal(readFileSync(join(dir, "状态.md"), "utf8"), "状态 v2");
  assert.equal(readFileSync(join(dir, "决定.md"), "utf8"), "决定 v2");
  const archive = contextOf(nextRun - 1).archive;
  assert.equal(archive.path, dir);
  assert.equal(archive.version, 2);
  assert.equal(archive.summary, "摘要 v2");
  assert.equal(archive.stale, undefined);
  assert.equal(hub.results[0].outcome, "done");
  assert.equal(hub.results[0].summary, "做完了 状态 v2");
});

test("a second job at the same version reads the cache, not the wire", async () => {
  const hub = fakeHub();
  hub.jobs.push(
    job({ project: "proj", address: "archive/proj", version: 5, summary: "" }),
    job({ project: "proj", address: "archive/proj", version: 5, summary: "" }),
    job({ project: "proj", address: "archive/proj", version: 6, summary: "" }),
  );
  const w = createWorker({ hub: hub as any, name: "w1", wait: 0 });
  await until(w, () => hub.results.length === 3);
  assert.deepEqual(hub.calls, [
    ["proj", 5],
    ["proj", 6],
  ]);
  assert.equal(contextOf(nextRun - 2).archive.version, 5);
  assert.equal(contextOf(nextRun - 1).archive.version, 6);
  assert.equal(readFileSync(join(home, "worker", "archives", "proj", "状态.md"), "utf8"), "状态 v6");
});

test("with the hub away and no copy, the run still goes and says what it couldn't get", async () => {
  const hub = fakeHub();
  hub.down = true;
  hub.jobs.push(job({ project: "fresh", address: "archive/fresh", version: 3, summary: "摘要" }));
  const w = createWorker({ hub: hub as any, name: "w1", wait: 0 });
  await until(w, () => hub.results.length === 1);
  const archive = contextOf(nextRun - 1).archive;
  assert.equal(archive.path ?? "", "");
  assert.equal(archive.stale, 3);
  assert.equal(hub.results[0].outcome, "done");
  assert.equal(hub.results[0].summary, "做完了 没有副本 v0 stale=3");
});

test("with the hub away and an older copy, the run reads it marked as stale", async () => {
  const dir = join(home, "worker", "archives", "proj");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "状态.md"), "状态 v1");
  writeFileSync(join(dir, "说明书.md"), "");
  writeFileSync(join(dir, "日志.md"), "");
  writeFileSync(join(dir, "决定.md"), "");
  writeFileSync(join(dir, "档案.json"), JSON.stringify({ project: "proj", version: 1, summary: "旧摘要" }));
  const hub = fakeHub();
  hub.down = true;
  hub.jobs.push(job({ project: "proj", address: "archive/proj", version: 2, summary: "" }));
  const w = createWorker({ hub: hub as any, name: "w1", wait: 0 });
  await until(w, () => hub.results.length === 1);
  const archive = contextOf(nextRun - 1).archive;
  assert.equal(archive.version, 1);
  assert.equal(archive.stale, 2);
  assert.equal(hub.results[0].summary, "做完了 状态 v1");
});

test("a hub that never heard of archives leaves the run alone", async () => {
  const hub = fakeHub() as any;
  delete hub.archive;
  hub.jobs.push(job({ project: "proj", address: "archive/proj", version: 1, summary: "" }));
  const w = createWorker({ hub, name: "w1", wait: 0 });
  await until(w, () => hub.results.length === 1);
  assert.equal(hub.results[0].outcome, "done");
});

test("a fetch that dies mid-swap doesn't replace the good copy", async () => {
  const dir = join(home, "worker", "archives", "proj");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "状态.md"), "状态 v7");
  writeFileSync(join(dir, "说明书.md"), "");
  writeFileSync(join(dir, "日志.md"), "");
  writeFileSync(join(dir, "决定.md"), "");
  writeFileSync(join(dir, "档案.json"), JSON.stringify({ project: "proj", version: 7, summary: "七" }));
  // A leftover half-done swap from a killed materialize: it must be ignored and cleaned by the next fetch.
  const tmp = `${dir}.tmp-1`;
  mkdirSync(tmp, { recursive: true });
  writeFileSync(join(tmp, "状态.md"), "残缺的");
  const hub = fakeHub();
  hub.jobs.push(job({ project: "proj", address: "archive/proj", version: 8, summary: "" }));
  const w = createWorker({ hub: hub as any, name: "w1", wait: 0 });
  await until(w, () => hub.results.length === 1);
  assert.equal(readFileSync(join(dir, "状态.md"), "utf8"), "状态 v8");
  assert.equal(readdirSync(join(home, "worker", "archives")).filter((n) => n.endsWith(".tmp-1")).length, 0);
});
