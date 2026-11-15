// The archive store: one Git repository per project under <data home>/archive/<项目编号>. Every write-back is one
// commit and one more version; 档案.json is generated after each commit (a file can't hold its own commit's hash) and
// records the real HEAD so a bucket copy describes itself without Git.
// Writes on one project serialize on a lock directory, so concurrent processes can't interleave a commit, its tag and
// the metadata. A crash mid-write-back leaves a committed-but-untagged (or tagged-but-unrecorded) state; recover()
// finishes or rebuilds it before the next write. A write-back can carry a dedup key: it lands in the commit body, so
// a retried write is reported as a duplicate instead of landing twice.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { HOME } from "../host/home.ts";
import {
  clean,
  commitAll,
  commitBodies,
  headCommit,
  initRepo,
  isAncestor,
  lsAt,
  refCommit,
  resetHard,
  showAt,
  status as dirtyTree,
  tag,
  tagCommits,
} from "./git.ts";

export const FILES = {
  meta: "档案.json",
  manual: "说明书.md",
  status: "状态.md",
  log: "日志.md",
  decisions: "决定.md",
  checkpoints: "检查点",
} as const;
const CONTENT_FILES = [FILES.manual, FILES.status, FILES.log, FILES.decisions] as const;

export function archiveRoot(root?: string) {
  return root ?? path.join(HOME, "archive");
}

export function archiveDir(project: string, root?: string) {
  return path.join(archiveRoot(root), project);
}

export type ArchiveContent = {
  project: string;
  version: number;
  commit: string;
  updatedAt: string;
  manual: string;
  status: string;
  log: string;
  decisions: string;
  checkpoints: string[];
  summary: string;
};

export type ArchiveWrite = {
  base: number;
  log?: (string | { text: string; at?: string })[];
  status?: string;
  decisions?: (string | { text: string; at?: string })[];
};

/** What came of a write-back: which sections merged, which were refused as stale, and the version it landed on. */
export type WriteResult = {
  wrote: boolean;
  version: number;
  commit: string;
  merged: string[];
  conflicts: string[];
  /** The same key already landed: nothing new was written; `conflicts` repeats what the first write reported. */
  duplicate?: boolean;
};

export class ArchiveError extends Error {}

type Meta = { project: string; version: number; head: string; updatedAt: string; applied: Record<string, string> };

const read = (dir: string, file: string) =>
  existsSync(path.join(dir, file)) ? readFileSync(path.join(dir, file), "utf8") : "";

function metaOf(dir: string): Meta {
  try {
    return JSON.parse(readFileSync(path.join(dir, FILES.meta), "utf8"));
  } catch {
    throw new ArchiveError(`${dir} 里的档案坏了：读不到 ${FILES.meta}`);
  }
}

function writeMeta(dir: string, meta: Meta) {
  const tmp = path.join(dir, `.${FILES.meta}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`);
  renameSync(tmp, path.join(dir, FILES.meta));
}

/** A copy can always be told apart from a live archive: this file is the one thing Git ignores. */
function seed(dir: string, project: string, options: { name?: string; manual?: string; status?: string }) {
  const { name, manual, status } = options;
  writeFileSync(path.join(dir, ".gitignore"), `${FILES.meta}\n.${FILES.meta}.tmp\n`);
  writeFileSync(
    path.join(dir, FILES.manual),
    manual ?? `# 说明书\n\n项目：${name ?? project}\n\n（目标、规则、权限、环境约定写在这里。）\n`,
  );
  writeFileSync(path.join(dir, FILES.status), status ?? `# 状态\n\n（还没有状态摘要。）\n`);
  writeFileSync(path.join(dir, FILES.log), "# 日志\n\n");
  writeFileSync(path.join(dir, FILES.decisions), "# 决定\n\n");
  mkdirSync(path.join(dir, FILES.checkpoints), { recursive: true });
  writeFileSync(path.join(dir, FILES.checkpoints, ".gitkeep"), "");
}

/**
 * Hold the project lock: a sibling directory `<project>.lock` taken with mkdir. The holder file records a pid, so a
 * lock abandoned by a dead process is taken over instead of waited on forever.
 */
function withLock<T>(dir: string, run: () => T): T {
  const lock = `${dir}.lock`;
  const deadline = Date.now() + 10_000;
  mkdirSync(path.dirname(lock), { recursive: true });
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      const holder = (() => {
        try {
          return JSON.parse(readFileSync(path.join(lock, "holder"), "utf8"));
        } catch {
          return null;
        }
      })();
      // A live holder keeps the lock. A dead one's is cleared, and so is a lock dir old enough that its holder
      // file would have been written — a brand new one without a holder is just being set up: wait for it.
      const born = (() => {
        try {
          return statSync(lock).birthtimeMs;
        } catch {
          return 0;
        }
      })();
      if (holder?.pid && alive(holder.pid)) {
        // keep waiting
      } else if (!holder && Date.now() - born < 30_000 && Date.now() <= deadline) {
        // keep waiting
      } else if (Date.now() <= deadline) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new ArchiveError(`等档案锁超时：${lock}`);
      sleep(25);
    }
  }
  try {
    writeFileSync(path.join(lock, "holder"), JSON.stringify({ pid: process.pid, at: Date.now() }));
    return run();
  } finally {
    rmSync(path.join(lock, "holder"), { force: true });
    rmdirSync(lock);
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Straighten the archive after a crash, inside the lock. A write-back killed mid-way leaves either a commit without
 * its tag (finish it: tag the next version number) or a tag whose 档案.json was never written (rebuild it). Leftover
 * uncommitted work — a write-back killed while editing — is discarded; its commit never landed so nothing is lost.
 */
function recover(dir: string) {
  const found = tagCommits(dir);
  const tags = Object.keys(found)
    .map((name) => ({ name, version: Number(name.slice(1)), commit: found[name] }))
    .filter((entry) => Number.isSafeInteger(entry.version))
    .sort((a, b) => a.version - b.version);
  const head = refCommit(dir, "HEAD");

  if (head && !tags.length) {
    tag(dir, "v0");
    tags.push({ name: "v0", version: 0, commit: head });
  } else if (head && tags.length && !isAncestor(dir, head, tags.at(-1)!.commit)) {
    const next = tags.at(-1)!.version + 1;
    tag(dir, `v${next}`);
    tags.push({ name: `v${next}`, version: next, commit: head });
  }

  const newest = tags.at(-1);
  if (newest && head !== newest.commit) {
    clean(dir);
    resetHard(dir, newest.commit);
  } else if (newest && dirtyTree(dir) !== "") {
    clean(dir);
    resetHard(dir, newest.commit);
  }
  if (!newest) throw new ArchiveError(`${dir} 里的档案坏了：没有任何提交`);

  // 档案.json is rebuilt, never trusted: version and head come from the tags, dedup keys from the commit bodies.
  const meta = (() => {
    try {
      return metaOf(dir);
    } catch {
      return null;
    }
  })();
  const applied: Record<string, string> = {};
  for (const { body } of commitBodies(dir)) {
    const key = /^archive-key: (.+)$/m.exec(body)?.[1];
    if (key) applied[key] = /^archive-conflicts: (.+)$/m.exec(body)?.[1] ?? "";
  }
  writeMeta(dir, {
    project: meta?.project ?? path.basename(dir),
    version: newest.version,
    head: newest.commit,
    updatedAt: meta?.updatedAt ?? new Date().toISOString(),
    applied,
  });
  return metaOf(dir);
}

export function initArchive(
  project: string,
  options: { root?: string; name?: string; manual?: string; status?: string } = {},
): { version: number; commit: string } {
  const dir = archiveDir(project, options.root);
  return withLock(dir, () => {
    if (existsSync(path.join(dir, FILES.meta))) throw new ArchiveError(`项目「${project}」的档案已经在了：${dir}`);
    if (existsSync(path.join(dir, ".git"))) {
      // A repository whose metadata vanished (deleted, or a half-finished pull): rebuild it, don't reseed.
      recover(dir);
      throw new ArchiveError(`项目「${project}」的档案已经在了：${dir}`);
    }
    mkdirSync(dir, { recursive: true });
    initRepo(dir);
    seed(dir, project, options);
    const commit = commitAll(dir, "建档")!;
    tag(dir, "v0");
    writeMeta(dir, {
      project,
      version: 0,
      head: commit,
      updatedAt: new Date().toISOString(),
      applied: {},
    });
    return { version: 0, commit };
  });
}

function content(dir: string, project: string, meta: Meta): ArchiveContent {
  const files = Object.fromEntries(CONTENT_FILES.map((file) => [file, read(dir, file)]));
  return {
    project,
    version: meta.version,
    commit: headCommit(dir),
    updatedAt: meta.updatedAt,
    manual: files[FILES.manual],
    status: files[FILES.status],
    log: files[FILES.log],
    decisions: files[FILES.decisions],
    checkpoints: existsSync(path.join(dir, FILES.checkpoints)) ? readdirSync(path.join(dir, FILES.checkpoints)) : [],
    summary: shortSummary(files[FILES.status], files[FILES.decisions]),
  };
}

export function readArchive(project: string, root?: string): ArchiveContent {
  const dir = archiveDir(project, root);
  if (!existsSync(path.join(dir, FILES.meta))) throw new ArchiveError(`项目「${project}」没有档案：${dir}`);
  return content(dir, project, metaOf(dir));
}

export function readArchiveAt(project: string, version: number, root?: string): ArchiveContent {
  const dir = archiveDir(project, root);
  if (!existsSync(dir)) throw new ArchiveError(`项目「${project}」没有档案：${dir}`);
  const ref = `v${version}`;
  const commit = refCommit(dir, ref);
  if (!commit) throw new ArchiveError(`项目「${project}」的档案没有版本 ${version}`);
  const status = showAt(dir, ref, FILES.status) ?? "";
  const decisions = showAt(dir, ref, FILES.decisions) ?? "";
  return {
    project,
    version,
    commit,
    updatedAt: "",
    manual: showAt(dir, ref, FILES.manual) ?? "",
    status,
    log: showAt(dir, ref, FILES.log) ?? "",
    decisions,
    checkpoints: lsAt(dir, ref, FILES.checkpoints).map((file) => path.basename(file)),
    summary: shortSummary(status, decisions),
  };
}

const entryText = (entry: string | { text: string; at?: string }) => (typeof entry === "string" ? entry : entry.text);
const dayOf = (iso?: string) => (iso ?? new Date().toISOString()).slice(0, 10);

function appendLines(file: string, entries: (string | { text: string; at?: string })[], by?: string) {
  const who = by ? `（${by}）` : "";
  const lines = entries.map(
    (entry) => `- ${dayOf(typeof entry === "string" ? undefined : entry.at)} ${entryText(entry)}${who}`,
  );
  writeFileSync(file, readFileSync(file, "utf8").replace(/\n*$/, "\n") + lines.join("\n") + "\n");
}

export function writeBack(
  project: string,
  write: ArchiveWrite,
  options: {
    root?: string;
    by?: string;
    at?: string;
    /** A retried write-back under the same key reports `duplicate` instead of writing twice. */
    key?: string;
    /** Test hook: die right after this step, like kill -9 mid-write-back. */
    halt?: "after-commit" | "after-tag";
  } = {},
): WriteResult {
  const dir = archiveDir(project, options.root);
  if (!Number.isSafeInteger(write.base) || write.base < 0) {
    throw new ArchiveError(`写回要带读到的版本号 base（非负整数）：${JSON.stringify(write.base)}`);
  }
  return withLock(dir, () => {
    if (!existsSync(path.join(dir, ".git"))) {
      if (write.base !== 0) throw new ArchiveError(`项目「${project}」的档案不存在，不可能读到版本 ${write.base}`);
      initArchiveInner(dir, project);
    }
    // Runs on every write: finishes or rebuilds a half-finished write-back and rewrites 档案.json from Git, so the
    // commit, its tag and the metadata can never disagree.
    const meta = recover(dir);
    if (write.base > meta.version) {
      throw new ArchiveError(`写回基于版本 ${write.base}，项目「${project}」的档案只有 ${meta.version} 版`);
    }
    if (options.key && meta.applied?.[options.key] !== undefined) {
      const conflicts = meta.applied[options.key].split(",").filter(Boolean);
      return { wrote: false, version: meta.version, commit: meta.head, merged: [], conflicts, duplicate: true };
    }
    const stale = write.base < meta.version;
    const merged: string[] = [];
    const conflicts: string[] = [];
    if (write.log?.length) {
      appendLines(path.join(dir, FILES.log), write.log, options.by);
      merged.push("log");
    }
    if (write.decisions?.length) {
      appendLines(path.join(dir, FILES.decisions), write.decisions, options.by);
      merged.push("decisions");
    }
    if (write.status !== undefined) {
      const same = write.status.trim() === read(dir, FILES.status).trim();
      if (same) {
        // Asking for what's already there is no write and no conflict.
      } else if (stale) {
        conflicts.push("status");
      } else {
        writeFileSync(path.join(dir, FILES.status), write.status.replace(/\n*$/, "\n"));
        merged.push("status");
      }
    }
    const trailer = options.key ? `archive-key: ${options.key}\narchive-conflicts: ${conflicts.join(",")}` : undefined;
    const commit = merged.length ? commitAll(dir, `写回 v${meta.version + 1}`, trailer) : null;
    if (options.halt === "after-commit") process.kill(process.pid, "SIGKILL");
    if (!commit) {
      return { wrote: false, version: meta.version, commit: headCommit(dir), merged: [], conflicts };
    }
    const version = meta.version + 1;
    tag(dir, `v${version}`);
    if (options.halt === "after-tag") process.kill(process.pid, "SIGKILL");
    writeMeta(dir, {
      ...meta,
      version,
      head: commit,
      updatedAt: options.at ?? new Date().toISOString(),
      applied: { ...meta.applied, ...(options.key ? { [options.key]: conflicts.join(",") } : {}) },
    });
    return { wrote: true, version, commit, merged, conflicts };
  });
}

function initArchiveInner(dir: string, project: string) {
  mkdirSync(dir, { recursive: true });
  initRepo(dir);
  seed(dir, project, {});
  const commit = commitAll(dir, "建档")!;
  tag(dir, "v0");
  writeMeta(dir, { project, version: 0, head: commit, updatedAt: new Date().toISOString(), applied: {} });
}

export function listArchives(root?: string): { project: string; version: number }[] {
  const base = archiveRoot(root);
  if (!existsSync(base)) return [];
  const found: { project: string; version: number }[] = [];
  for (const name of readdirSync(base)) {
    const dir = path.join(base, name);
    try {
      if (!existsSync(path.join(dir, FILES.meta))) continue;
      found.push({ project: name, version: metaOf(dir).version });
    } catch {
      continue;
    }
  }
  return found.sort((a, b) => a.project.localeCompare(b.project));
}

/** What a dispatch carries: the top of the status plus the newest decision titles, capped to a few hundred characters. */
export function shortSummary(status: string, decisions: string): string {
  const room = 400;
  const statusLine = status
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("（"))
    .slice(0, 2)
    .join(" ");
  const titles = decisions
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .slice(-2)
    .map((line) => line.replace(/^- \d{4}-\d{2}-\d{2} ?/, "").replace(/（[^（）]*）$/, ""));
  const tail = titles.length ? `\n最近决定：${titles.join("；")}` : "";
  const budget = Math.max(0, room - tail.length - 1);
  const head = statusLine.length > budget ? `${statusLine.slice(0, budget)}…` : statusLine;
  return `${head}${tail}`.trim();
}
