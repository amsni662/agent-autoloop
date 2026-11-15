// A thin wrapper over the system `git`: an archive's history lives in real commits, so nothing here invents storage.
// Commits carry a fixed robot identity from the environment, never the user's own Git configuration.
import { spawnSync } from "node:child_process";

export class GitError extends Error {
  readonly args: string[];
  readonly output: string;
  constructor(args: string[], output: string) {
    super(`git ${args.join(" ")} 没跑成：${output.trim().split("\n").at(-1) ?? output}`);
    this.args = args;
    this.output = output;
  }
}

const IDENTITY = {
  GIT_AUTHOR_NAME: "ai-loop archive",
  GIT_AUTHOR_EMAIL: "archive@agent-autoloop.local",
  GIT_COMMITTER_NAME: "ai-loop archive",
  GIT_COMMITTER_EMAIL: "archive@agent-autoloop.local",
};

export function git(dir: string, args: string[]): string {
  const ran = spawnSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...IDENTITY },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (ran.error) throw ran.error;
  const output = `${ran.stdout ?? ""}${ran.stderr ?? ""}`;
  if (ran.status !== 0) throw new GitError(args, output);
  return ran.stdout ?? "";
}

export function initRepo(dir: string) {
  git(dir, ["init", "-b", "main", "."]);
}

export function headCommit(dir: string): string {
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

/** Everything staged in one commit; empty when nothing changed. `trailer` becomes the commit body (dedup keys). */
export function commitAll(dir: string, message: string, trailer?: string): string | null {
  git(dir, ["add", "-A"]);
  if (git(dir, ["status", "--porcelain"]).trim() === "") return null;
  git(dir, ["commit", "-m", message, ...(trailer ? ["-m", trailer] : [])]);
  return headCommit(dir);
}

export function tag(dir: string, name: string) {
  git(dir, ["tag", name]);
}

/** Uncommitted changes, one per line; empty when the tree is clean. */
export function status(dir: string): string {
  return git(dir, ["status", "--porcelain"]).trim();
}

export function resetHard(dir: string, ref: string) {
  git(dir, ["reset", "--hard", ref]);
}

/** Remove untracked files; ignored files (档案.json) stay. */
export function clean(dir: string) {
  git(dir, ["clean", "-fd"]);
}

/** Whether `a` is an ancestor commit of `b`. */
export function isAncestor(dir: string, a: string, b: string): boolean {
  const ran = spawnSync("git", ["-C", dir, "merge-base", "--is-ancestor", a, b], {
    env: { ...process.env, ...IDENTITY },
  });
  return ran.status === 0;
}

/** Every version tag and the commit it points at: { "v3": "abc…" }. */
export function tagCommits(dir: string): Record<string, string> {
  const out = git(dir, ["for-each-ref", "refs/tags", "--format=%(refname:short)%00%(objectname)"]).trim();
  const found: Record<string, string> = {};
  for (const line of out ? out.split("\n") : []) {
    const [name, commit] = line.split("\0");
    found[name] = commit;
  }
  return found;
}

/** Each commit's hash and full message body, oldest first: for rebuilding the dedup map after a crash. */
export function commitBodies(dir: string): { hash: string; body: string }[] {
  const out = git(dir, ["log", "--reverse", "--format=%H%x00%B%x01"]);
  const found: { hash: string; body: string }[] = [];
  for (const part of out.split("\x01")) {
    if (!part.trim()) continue;
    const [hash, ...rest] = part.trimStart().split("\0");
    found.push({ hash, body: rest.join("\0") });
  }
  return found;
}

/** The commit a ref points at, or null when it doesn't exist. */
export function refCommit(dir: string, ref: string): string | null {
  const ran = spawnSync("git", ["-C", dir, "rev-parse", "--verify", `${ref}^{commit}`], {
    encoding: "utf8",
    env: { ...process.env, ...IDENTITY },
  });
  return ran.status === 0 ? String(ran.stdout).trim() : null;
}

/** A file's content at a ref, or null when it isn't in that tree. */
export function showAt(dir: string, ref: string, file: string): string | null {
  const ran = spawnSync("git", ["-C", dir, "show", `${ref}:${file}`], {
    encoding: "utf8",
    env: { ...process.env, ...IDENTITY },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (ran.status !== 0) return null;
  return ran.stdout ?? "";
}

/** Paths under a directory at a ref, one per line. */
export function lsAt(dir: string, ref: string, folder: string): string[] {
  const out = git(dir, ["ls-tree", "-r", "--name-only", ref, "--", folder]);
  return out.trim() ? out.trim().split("\n") : [];
}
