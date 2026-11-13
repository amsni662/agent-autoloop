// The archive store: one Git repository per project under the data home. Failure cases: two runs writing back on the
// same base quietly overwriting each other's status; a status summary written over a version it never read; log entries
// lost instead of merged; reading an old version returning the newest content; a version that doesn't advance; a write
// without a base, or with a base the archive can't have shown, counting as written; the metadata file drifting out of
// step with the real commits; a missing archive treated as an error where first write-back should just start it.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("archive");
const store = await import("../archive/store.ts");
const { initArchive, listArchives, readArchive, readArchiveAt, writeBack } = store;
const dir = (project: string) => store.archiveDir(project, join(home, "archive"));

test("initializing an archive makes version 0 with the five standard files and a Git repository", () => {
  const made = initArchive("ai-loop", { root: join(home, "archive"), name: "AI Loop" });
  assert.equal(made.version, 0);
  assert.ok(made.commit);
  for (const file of ["档案.json", "说明书.md", "状态.md", "日志.md", "决定.md"]) {
    assert.ok(existsSync(join(dir("ai-loop"), file)), file);
  }
  assert.ok(existsSync(join(dir("ai-loop"), "检查点")));
  assert.ok(existsSync(join(dir("ai-loop"), ".git")));
  const meta = JSON.parse(readFileSync(join(dir("ai-loop"), "档案.json"), "utf8"));
  assert.equal(meta.project, "ai-loop");
  assert.equal(meta.version, 0);
  assert.equal(meta.head, made.commit);
});

test("a write-back on the read base advances the version, records the commit and updates files", () => {
  initArchive("shop", { root: join(home, "archive") });
  const before = readArchive("shop", join(home, "archive"));
  assert.equal(before.version, 0);
  const wrote = writeBack(
    "shop",
    { base: 0, log: ["巡检：一切正常"], status: "# 状态\n上一轮巡检正常。", decisions: ["用 Git 存档案"] },
    { root: join(home, "archive"), by: "run 41" },
  );
  assert.equal(wrote.wrote, true);
  assert.equal(wrote.version, 1);
  assert.deepEqual(wrote.conflicts, []);
  const after = readArchive("shop", join(home, "archive"));
  assert.equal(after.version, 1);
  assert.equal(after.commit, wrote.commit);
  assert.match(after.status, /上一轮巡检正常/);
  assert.match(after.log, /巡检：一切正常/);
  assert.match(after.log, /run 41/, "the write-back says who wrote it");
  assert.match(after.decisions, /用 Git 存档案/);
  const meta = JSON.parse(readFileSync(join(dir("shop"), "档案.json"), "utf8"));
  assert.equal(meta.version, 1);
  assert.equal(meta.head, wrote.commit);
});

test("reading a version gives that version's content, not the newest", () => {
  writeBack("shop", { base: 1, log: ["第二次"], status: "第二版的状态。" }, { root: join(home, "archive") });
  const v1 = readArchiveAt("shop", 1, join(home, "archive"));
  assert.equal(v1.version, 1);
  assert.match(v1.status, /上一轮巡检正常/);
  assert.doesNotMatch(v1.log, /第二次/);
  const v2 = readArchiveAt("shop", 2, join(home, "archive"));
  assert.match(v2.status, /第二版的状态/);
  assert.throws(() => readArchiveAt("shop", 99, join(home, "archive")), /版本/);
});

test("two write-backs on the same base: the later one's log merges but its status is refused and reported", () => {
  initArchive("feeds", { root: join(home, "archive") });
  const first = writeBack(
    "feeds",
    { base: 0, log: ["甲轮：收了 3 条"], status: "甲写的状态。" },
    { root: join(home, "archive"), by: "run 10" },
  );
  assert.equal(first.version, 1);
  // The second run read version 0 too, before the first wrote.
  const second = writeBack(
    "feeds",
    { base: 0, log: ["乙轮：收了 5 条"], status: "乙写的状态。", decisions: ["乙定的"] },
    { root: join(home, "archive"), by: "run 11" },
  );
  assert.equal(second.wrote, true, "mergeable parts still go in");
  assert.deepEqual(second.conflicts, ["status"]);
  assert.equal(second.version, 2);
  const now = readArchive("feeds", join(home, "archive"));
  assert.match(now.log, /甲轮：收了 3 条/);
  assert.match(now.log, /乙轮：收了 5 条/, "log entries always merge");
  assert.match(now.decisions, /乙定的/);
  assert.match(now.status, /甲写的状态/, "the stale base's status must not overwrite");
  assert.doesNotMatch(now.status, /乙写的状态/);
});

test("a stale-base write-back with only a status is refused outright: nothing commits", () => {
  const before = readArchive("feeds", join(home, "archive"));
  const refused = writeBack("feeds", { base: 0, status: "过期的状态。" }, { root: join(home, "archive") });
  assert.equal(refused.wrote, false);
  assert.deepEqual(refused.conflicts, ["status"]);
  assert.equal(refused.version, before.version);
  assert.equal(readArchive("feeds", join(home, "archive")).commit, before.commit);
});

test("a stale base carrying the same status the archive already holds is no conflict", () => {
  const now = readArchive("feeds", join(home, "archive"));
  const same = writeBack(
    "feeds",
    { base: 0, status: now.status, log: ["重复状态下的追加"] },
    { root: join(home, "archive") },
  );
  assert.deepEqual(same.conflicts, []);
  assert.equal(same.wrote, true);
});

test("a base the archive can't have shown, no base at all, or a base that isn't a number is refused", () => {
  initArchive("blog", { root: join(home, "archive") });
  assert.throws(() => writeBack("blog", { base: 5, log: ["x"] }, { root: join(home, "archive") }), /版本/);
  for (const base of [undefined, "0", -1, 1.5] as any[]) {
    assert.throws(() => writeBack("blog", { base, log: ["x"] }, { root: join(home, "archive") }), /base/);
  }
});

test("a first write-back on a project that has no archive starts it at version 0, then writes version 1", () => {
  const wrote = writeBack("fresh", { base: 0, log: ["第一轮"], status: "起步。" }, { root: join(home, "archive") });
  assert.equal(wrote.version, 1);
  assert.match(readArchive("fresh", join(home, "archive")).status, /起步/);
  assert.throws(() => writeBack("gone", { base: 3, log: ["x"] }, { root: join(home, "archive") }), /不存在|版本/);
});

test("the summary reads the top of the status and the latest decision titles, not whole files", () => {
  writeFileSync(join(dir("feeds"), "状态.md"), "# 状态\n甲写的状态。\n\n" + "补充说明。".repeat(60));
  writeFileSync(
    join(dir("feeds"), "决定.md"),
    "- 2026-11-01 定了第一件事\n- 2026-11-12 定了第二件事\n- 2026-11-13 定了第三件事\n",
  );
  const git = (args: string[]) =>
    spawnSync("git", ["-C", dir("feeds"), ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  git(["add", "-A"]);
  git(["commit", "-m", "手动补充"]);
  const read = readArchive("feeds", join(home, "archive"));
  assert.ok(read.summary.length <= 400, read.summary.length.toString());
  assert.match(read.summary, /甲写的状态/);
  assert.match(read.summary, /定了第三件事/);
  assert.doesNotMatch(read.summary, /定了第一件事/);
});

test("listArchives names every project's archive and its version", () => {
  const decoy = join(home, "archive", "not-an-archive");
  mkdirSync(decoy, { recursive: true });
  writeFileSync(join(decoy, "随手文件.md"), "不是档案");
  const listed = listArchives(join(home, "archive"));
  const byName = Object.fromEntries(listed.map((item) => [item.project, item.version]));
  assert.equal(byName["feeds"], readArchive("feeds", join(home, "archive")).version);
  assert.equal(byName["shop"], 2);
  assert.ok(!("not-an-archive" in byName));
});
