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

/** Everything staged in one commit; empty when nothing changed. */
export function commitAll(dir: string, message: string): string | null {
  git(dir, ["add", "-A"]);
  if (git(dir, ["status", "--porcelain"]).trim() === "") return null;
  git(dir, ["commit", "-m", message]);
  return headCommit(dir);
}

export function tag(dir: string, name: string) {
  git(dir, ["tag", name]);
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
