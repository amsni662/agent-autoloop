// The archive subcommand against the real program: a write-back through stdin, reading back at a version, a stale
// write saying so with a failing exit, and a sync without credentials refusing before it touches the network. Failure
// cases: a command accepting what the store refuses; conflicts exiting 0 so a caller thinks all of it landed; missing
// credentials producing a stack trace or a request instead of a sentence.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = join(import.meta.dirname, "..");
const home = mkdtempSync(join(tmpdir(), "agent-autoloop-archive-cli-"));
after(() => rmSync(home, { recursive: true, force: true }));

const cli = (input: string | null, ...args: string[]) =>
  spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "bin/agent-autoloop.ts", ...args], {
    cwd: root,
    env: { ...process.env, AGENT_AUTOLOOP_HOME: home },
    encoding: "utf8",
    input: input ?? undefined,
  });

test("write back through stdin, then show it and an older version", () => {
  const wrote = cli(
    '{"base":0,"log":["第一轮巡检正常"],"status":"# 状态\\n巡检过了。","decisions":["每天巡"]}',
    "archive",
    "write",
    "ops",
  );
  assert.equal(wrote.status, 0, wrote.stderr);
  assert.match(wrote.stdout, /版本 1/);
  const shown = cli(null, "archive", "show", "ops");
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /版本 1/);
  assert.match(shown.stdout, /巡检过了/);
  const old = cli(null, "archive", "show", "ops", "--version", "0");
  assert.equal(old.status, 0, old.stderr);
  assert.match(old.stdout, /版本 0/);
  assert.doesNotMatch(old.stdout, /巡检过了/);
});

test("a write-back on a stale base prints the conflict and fails", () => {
  const first = cli('{"base":1,"log":["甲"],"status":"甲的状态"}', "archive", "write", "ops");
  assert.equal(first.status, 0, first.stderr);
  const second = cli('{"base":1,"log":["乙"],"status":"乙的状态"}', "archive", "write", "ops");
  assert.equal(second.status, 1);
  assert.match(second.stdout, /写回了：项目「ops」版本 3/);
  assert.match(second.stderr, /状态没写回/);
  const shown = cli(null, "archive", "show", "ops");
  assert.match(shown.stdout, /甲的状态/);
  assert.match(readFileSync(join(home, "archive", "ops", "日志.md"), "utf8"), /乙/, "the log still merged");
});

test("a write-back that is not JSON, or has no base, is refused with words", () => {
  const bad = cli("not json", "archive", "write", "ops");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /JSON/);
  const noBase = cli('{"log":["x"]}', "archive", "write", "ops");
  assert.equal(noBase.status, 1);
  assert.match(noBase.stderr, /base/);
});

test("sync without bucket credentials says which variables are missing and sends nothing", () => {
  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_AUTOLOOP_HOME: home };
  for (const name of Object.keys(env)) if (name.startsWith("ARCHIVE_S3_")) delete env[name];
  const ran = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "bin/agent-autoloop.ts", "archive", "sync", "ops"],
    {
      cwd: root,
      env,
      encoding: "utf8",
    },
  );
  assert.equal(ran.status, 1);
  assert.match(ran.stderr, /ARCHIVE_S3_ENDPOINT/);
  assert.match(ran.stderr, /secrets\.env|环境/);
});

test("bare archive lists projects and their versions", () => {
  const listed = cli(null, "archive");
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /ops\t版本 3/);
});
