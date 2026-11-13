// Mirroring an archive to the bucket and back. Push sends the whole project directory including .git (so a copy keeps
// every version), uploads only objects whose MD5 differs, and removes remote extras so the prefix stays a mirror. Pull
// does the same in reverse into a local directory, for a device to read when the hub can't be reached.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { archiveDir, FILES, listArchives } from "./store.ts";
import { deleteObject, getObject, listObjects, putObject, s3FromEnv, type S3Config } from "./s3.ts";

const md5 = (body: Buffer) => createHash("md5").update(body).digest("hex");

/** Every file under a directory as relative paths, .git included. */
function walk(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) found.push(...walk(full).map((child) => `${name}/${child}`));
    else found.push(name);
  }
  return found.sort();
}

const prefixOf = (project: string) => `archive/${project}/`;

export type SyncResult = { project: string; sent: number; removed: number; skipped: number };

export async function pushArchive(
  project: string,
  options: { root?: string; s3?: S3Config } = {},
): Promise<SyncResult> {
  const cfg = options.s3 ?? s3FromEnv();
  const dir = archiveDir(project, options.root);
  if (!existsSync(path.join(dir, FILES.meta))) throw new Error(`项目「${project}」没有档案：${dir}`);
  const prefix = prefixOf(project);
  const remote = new Map((await listObjects(cfg, prefix)).map((item) => [item.key, item.etag]));
  const files = walk(dir);
  let sent = 0,
    skipped = 0;
  for (const file of files) {
    const key = `${prefix}${file}`;
    const body = readFileSync(path.join(dir, file));
    if (remote.get(key) === md5(body)) {
      skipped += 1;
      continue;
    }
    await putObject(cfg, key, body);
    sent += 1;
  }
  const local = new Set(files.map((file) => `${prefix}${file}`));
  let removed = 0;
  for (const key of remote.keys()) {
    if (local.has(key)) continue;
    await deleteObject(cfg, key);
    removed += 1;
  }
  return { project, sent, removed, skipped };
}

export async function pushAll(options: { root?: string; s3?: S3Config } = {}): Promise<SyncResult[]> {
  const cfg = options.s3 ?? s3FromEnv();
  const results: SyncResult[] = [];
  for (const { project } of listArchives(options.root)) {
    results.push(await pushArchive(project, { root: options.root, s3: cfg }));
  }
  return results;
}

/** A read-only copy: every object under the prefix lands under <to>/<project>, local extras are cleared. */
export async function pullArchive(
  project: string,
  to: string,
  options: { s3?: S3Config } = {},
): Promise<{ project: string; version: number; files: number }> {
  const cfg = options.s3 ?? s3FromEnv();
  const prefix = prefixOf(project);
  const objects = await listObjects(cfg, prefix);
  if (!objects.length) throw new Error(`桶里没有项目「${project}」的档案（${prefix}）`);
  const dir = path.join(to, project);
  mkdirSync(dir, { recursive: true });
  const wanted = new Set(objects.map((item) => item.key.slice(prefix.length)));
  for (const file of existsSync(dir) ? walk(dir) : []) {
    if (!wanted.has(file)) rmSync(path.join(dir, file), { force: true });
  }
  for (const item of objects) {
    const rel = item.key.slice(prefix.length);
    const target = path.join(dir, rel);
    const body = await getObject(cfg, item.key);
    if (body === null) continue;
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  const meta = JSON.parse(readFileSync(path.join(dir, FILES.meta), "utf8")) as { version: number };
  return { project, version: meta.version, files: wanted.size };
}
