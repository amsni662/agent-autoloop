// Failure cases: several processes writing back to one project at once losing a version or making two commits share a
// tag; a writer killed between commit and tag (or tag and 档案.json) leaving the archive inconsistent for the next
// writer; a retried write-back appending its entries twice; a lock left by a dead process blocking every later write.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("archive-lock");
const store = await import("../archive/store.ts");
const git = await import("../archive/git.ts");
const { initArchive, readArchive, writeBack } = store;
const root = join(home, "archive");
const dir = (project: string) => store.archiveDir(project, root);
const childFile = join(import.meta.dirname, "archive-child.ts");

function runWriter(project: string, count: number, me: string, env: NodeJS.ProcessEnv = {}) {
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", childFile, project, root, String(count), me],
    { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] },
  );
  let said = "";
  child.stderr.on("data", (chunk) => (said += chunk));
  return new Promise<{ code: number | null; signal: string | null; said: string }>((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal, said })),
  );
}

const tags = (project: string) =>
  git
    .git(dir(project), ["tag", "-l", "v[0-9]*"])
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((name) => Number(name.slice(1)))
    .sort((a, b) => a - b);

function consistent(project: string) {
  const meta = JSON.parse(spawnSync("cat", [join(dir(project), "档案.json")], { encoding: "utf8" }).stdout);
  const numbers = tags(project);
  const highest = numbers.at(-1);
  assert.equal(meta.version, highest, "档案.json's version is the newest tag");
  assert.equal(meta.head, git.refCommit(dir(project), `v${highest}`));
  assert.equal(git.headCommit(dir(project)), git.refCommit(dir(project), `v${highest}`));
  for (let v = 0; v <= highest!; v++) assert.ok(numbers.includes(v), `tag v${v} missing`);
  assert.equal(git.git(dir(project), ["status", "--porcelain"]).trim(), "", "nothing uncommitted");
  return meta;
}

test("processes writing back at the same time each get their own version", async () => {
  initArchive("many", { root });
  const writers = ["甲", "乙", "丙", "丁"].map((me) => runWriter("many", 5, me));
  const results = await Promise.all(writers);
  for (const result of results) {
    assert.equal(result.code, 0, result.said);
    assert.equal(result.signal, null, result.said);
  }
  const meta = consistent("many");
  assert.equal(meta.version, 20, "every write-back made exactly one version");
  const log = readArchive("many", root).log;
  for (const me of ["甲", "乙", "丙", "丁"]) {
    for (let i = 0; i < 5; i++) assert.ok(log.includes(`${me} 的第 ${i} 笔`), `${me} ${i} is in the log`);
  }
});

test("a writer killed after its commit leaves an archive the next write-back repairs", async () => {
  initArchive("killed", { root });
  const gone = await runWriter("killed", 1, "早夭", { HALT: "after-commit" });
  assert.equal(gone.signal, "SIGKILL");
  // The half version is finished, not lost: what was committed becomes a real version.
  const wrote = writeBack("killed", { base: 0, log: ["接着的一笔"] }, { root });
  assert.equal(wrote.wrote, true);
  const meta = consistent("killed");
  assert.equal(meta.version, 2, "the orphaned commit was tagged v1 before v2 landed");
  const log = readArchive("killed", root).log;
  assert.match(log, /早夭 的第 0 笔/);
  assert.match(log, /接着的一笔/);
});

test("a writer killed after its tag leaves metadata the next write-back rebuilds", async () => {
  initArchive("halved", { root });
  const gone = await runWriter("halved", 1, "半路", { HALT: "after-tag" });
  assert.equal(gone.signal, "SIGKILL");
  const wrote = writeBack("halved", { base: 0, log: ["恢复后的写回"] }, { root });
  assert.equal(wrote.wrote, true);
  const meta = consistent("halved");
  assert.equal(meta.version, 2);
  const log = readArchive("halved", root).log;
  assert.match(log, /半路 的第 0 笔/);
  assert.match(log, /恢复后的写回/);
});

test("a write-back retried under the same key lands once, not twice", () => {
  initArchive("again", { root });
  const first = writeBack("again", { base: 0, log: ["同一笔"] }, { root, key: "run:1:abc" });
  assert.equal(first.version, 1);
  const retry = writeBack("again", { base: 0, log: ["同一笔"] }, { root, key: "run:1:abc" });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.version, 1);
  const log = readArchive("again", root).log;
  assert.equal(log.split("同一笔").length - 1, 1, "the entry is there exactly once");
  const third = writeBack("again", { base: 1, log: ["另一笔"] }, { root, key: "run:1:def" });
  assert.equal(third.version, 2, "a different key is a different write");
});

test("a lock abandoned by a dead process doesn't block the next write-back", () => {
  initArchive("stuck", { root });
  // A lock dir beside the archive, held by a pid that has already exited.
  const dead = spawnSync("true");
  const lock = `${dir("stuck")}.lock`;
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "holder"), JSON.stringify({ pid: dead.pid, at: Date.now() - 120_000 }));
  const wrote = writeBack("stuck", { base: 0, log: ["没等死掉的锁"] }, { root });
  assert.equal(wrote.wrote, true);
});
