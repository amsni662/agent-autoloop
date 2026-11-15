// Failure cases: a project rule's job not carrying the archive pointer; a finished run's receipt write-back lost
// before the sidecar reads it, or applied twice on retry; a done receipt without an archive section counted as
// finished; a command agent's log-only write being demanded of it too; a stale base's status silently overwriting;
// an owner's answer to a project card never reaching 决定.md; a write claimed by a dead worker never coming back.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("archive-kernel", "rules.archive.json");
const hub = await import("./hub.ts");
const { rows } = await import("../kernel/evolve.ts");
const store = await import("../archive/store.ts");
const { ingest, claimNext, finish, answer, createCard, execute, getView } = hub;

const root = join(home, "archive");
const pending = () => rows(getView(), "archive_writes", { state: "pending" });
const run = (id: number) => getView().get("runs", id)!;
const archiveRow = () => getView().get("archives", "proj")!;
const openCard = (key: string) => rows(getView(), "cards").find((c) => c.state === "open" && c.key === key);
const onDisk = () => {
  try {
    return store.readArchive("proj", root).version;
  } catch {
    return 0;
  }
};

/** What the host sidecar does with each pending write: claim, write, report. Non-receipt records ride on the version now on disk. */
function drivePending(marker = "test") {
  const out = [];
  // Like the sidecar: receipts first, so the same run's auto-log can't make its own base stale.
  const batch = pending().sort((a, b) => Number(b.kind === "receipt") - Number(a.kind === "receipt"));
  for (const rec of batch) {
    assert.equal(execute("archiveClaim", [rec.key, marker]), true);
    assert.equal(execute("archiveClaim", [rec.key, marker]), false, "claiming twice");
    const payload = JSON.parse(rec.payload);
    const write = rec.kind === "receipt" ? payload : { base: onDisk(), ...payload };
    const r = store.writeBack(rec.project, write, { root, key: rec.key, by: rec.by });
    const archive = store.readArchive(rec.project, root);
    execute("archiveDone", [
      rec.key,
      { project: rec.project, version: r.version, summary: archive.summary, commit: r.commit, conflicts: r.conflicts },
    ]);
    out.push(r);
  }
  return out;
}

/** A project run claimed in a test is finished and flushed, so the group is free for the next claim. */
function claimWork(claim: string, snapshot?: object) {
  ingest("app", { id: `e-${claim}`, type: "work.thing" });
  const job = execute("claimNext", ["w1", claim, snapshot]);
  assert.ok(job, `${claim}: nothing to claim`);
  return job;
}

test("a project rule's job carries the archive pointer; a plain rule's doesn't", () => {
  const job = claimWork("c1");
  assert.deepEqual(job.archive, { project: "proj", address: "archives/proj", version: 0, summary: "" });
  finish(job.run, job.token, { outcome: "done", archive: { base: 0, log: ["第一轮"] } });
  drivePending();
  ingest("app", { id: "p1", type: "plain.thing" });
  const plain = claimNext("w1", "c2")!;
  assert.equal(plain.archive, undefined);
  finish(plain.run, plain.token, { outcome: "done" });
});

test("a dispatch-time snapshot fills the archive section and refreshes the projection", () => {
  const job = claimWork("c3", { proj: { version: 3, summary: "做到一半", commit: "abc" } });
  assert.equal(job.archive.version, 3);
  assert.equal(job.archive.summary, "做到一半");
  assert.equal(archiveRow().version, 3);
  assert.equal(archiveRow().summary, "做到一半");
  assert.equal(archiveRow().commit, "abc");
  finish(job.run, job.token, { outcome: "done", archive: { base: onDisk(), log: ["第二轮"] } });
  drivePending();
});

test("a receipt's archive payload and the automatic log both land in the archive", () => {
  const job = claimWork("c4");
  finish(job.run, job.token, {
    outcome: "done",
    summary: "做完了",
    archive: { base: onDisk(), log: ["这一轮写回"], status: "状态整篇" },
  });
  const recs = pending();
  assert.deepEqual(recs.map((r) => r.kind).sort(), ["log", "receipt"]);
  assert.equal(recs.find((r) => r.kind === "log")!.payload.includes("项目活"), true);
  drivePending();
  assert.equal(run(job.run).archive, "written");
  const archive = store.readArchive("proj", root);
  assert.equal(archive.status.trim(), "状态整篇");
  assert.equal(archive.log.includes("这一轮写回"), true);
  assert.equal(archive.log.includes("「项目活」"), true);
  assert.equal(archiveRow().version, archive.version);
});

test("done without an archive section on an agent that could write is flagged and told", () => {
  const job = claimWork("c5");
  finish(job.run, job.token, { outcome: "done", summary: "忘了写回" });
  assert.equal(run(job.run).archive, "missing");
  assert.equal(openCard(`run:${job.run}:archive-missing`)?.kind, "notice");
  drivePending();
});

test("a command agent is logged automatically but never asked for a write-back", () => {
  ingest("app", { id: "c1", type: "chore.thing" });
  const job = claimNext("w1", "c6")!;
  finish(job.run, job.token, { outcome: "done", summary: "跑完了" });
  assert.equal(run(job.run).archive, null);
  assert.equal(openCard(`run:${job.run}:archive-missing`), undefined);
  assert.deepEqual(
    pending().map((r) => r.kind),
    ["log"],
  );
  drivePending();
});

test("a plain rule leaves no archive writes and no missing flag", () => {
  ingest("app", { id: "p2", type: "plain.thing" });
  const job = claimNext("w1", "c7")!;
  finish(job.run, job.token, { outcome: "done" });
  assert.equal(pending().length, 0);
  assert.equal(run(job.run).archive, null);
});

test("a stale base merges what can merge and asks the owner about the rest", () => {
  const job = claimWork("c8");
  finish(job.run, job.token, {
    outcome: "done",
    archive: { base: 0, log: ["落后的那轮"], status: "过时状态" },
  });
  drivePending();
  assert.equal(run(job.run).archive, "conflict");
  const card = openCard(`run:${job.run}:archive-conflict`)!;
  assert.equal(card?.kind, "ask");
  assert.deepEqual(JSON.parse(card?.options ?? "[]"), ["以档案里现在的为准", "重新提交这次写回"]);
  const archive = store.readArchive("proj", root);
  assert.equal(archive.log.includes("落后的那轮"), true, "the mergeable part still landed");
  assert.notEqual(archive.status, "过时状态");
});

test("an owner's answer to a project rule's card becomes a 决定.md entry", () => {
  const { card } = createCard({
    key: "ask:1",
    rule: "项目活",
    kind: "ask",
    title: "选哪个方案",
    options: ["方案甲", "方案乙"],
  });
  answer(card, { choice: 0, by: "owner" });
  const rec = pending().find((r) => r.kind === "decision")!;
  assert.equal(rec.key, `card:${card}`);
  assert.equal(rec.by, "owner");
  drivePending();
  assert.equal(store.readArchive("proj", root).decisions.includes("方案甲"), true);
  // The answer also woke the rule up: its queued round would hold the group; it's not this test's business.
  const stray = rows(getView(), "runs", { state: "queued" }).find((r) => r.rule === "项目活");
  if (stray) execute("cancel", [stray.id]);
});

test("a write claimed by a dead worker goes back to pending", () => {
  const job = claimWork("c9");
  finish(job.run, job.token, { outcome: "done", archive: { base: onDisk(), log: ["再来一条"] } });
  const rec = pending().find((r) => r.kind === "receipt")!;
  assert.equal(execute("archiveClaim", [rec.key, "gone:1"]), true);
  execute("archiveStale", ["test", new Date(Date.now() + 60_000).toISOString()]);
  assert.equal(
    pending().some((r) => r.key === rec.key),
    true,
  );
  drivePending();
  assert.equal(run(job.run).archive, "written");
});

test("a write the claimant still holds stays claimed", () => {
  const job = claimWork("c11");
  finish(job.run, job.token, { outcome: "done", archive: { base: onDisk(), log: ["还在写"] } });
  const rec = pending().find((r) => r.kind === "receipt" && r.run === job.run)!;
  assert.equal(execute("archiveClaim", [rec.key, "test:9"]), true);
  execute("archiveStale", ["test", new Date(Date.now() + 60_000).toISOString()]);
  assert.equal(getView().get("archive_writes", rec.key)!.state, "writing");
  execute("archiveStale", ["other", new Date(Date.now() - 60_000).toISOString()]);
  assert.equal(getView().get("archive_writes", rec.key)!.state, "writing", "claimed after the cutoff");
  execute("archiveDone", [rec.key, { project: "proj", version: onDisk() }]);
  drivePending();
});

test("a failed write marks the run and tells the owner", () => {
  const job = claimWork("c10");
  finish(job.run, job.token, { outcome: "done", archive: { base: onDisk(), log: ["会失败"] } });
  const rec = pending().find((r) => r.kind === "receipt" && r.run === job.run)!;
  execute("archiveClaim", [rec.key, "test"]);
  execute("archiveDone", [rec.key, { project: "proj", error: "磁盘满了" }]);
  assert.equal(run(job.run).archive, "error");
  assert.equal(openCard(`run:${job.run}:archive-error`)?.kind, "notice");
  drivePending();
});

test("writeBack deduplicates a retried key instead of writing a second version", () => {
  const before = onDisk();
  const payload = { base: before, log: ["重试的同一条"] };
  const first = store.writeBack("proj", payload, { root, key: "dedup:test" });
  const again = store.writeBack("proj", payload, { root, key: "dedup:test" });
  assert.equal(again.version, first.version);
  assert.equal(onDisk(), first.version);
});
