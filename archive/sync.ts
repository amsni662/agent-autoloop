// Mirroring an archive to the bucket and back. A push publishes a whole version, never file by file into a shared
// spot: everything goes under <前缀>archive/<项目>/v<N>/ (unchanged objects skip by MD5), and only once the version is
// complete does the `current.json` pointer move to it — readers see either the old version or the new one, never a
// half-uploaded mix. Old versions stay in place so a pulled copy still serves every tag. A pull reads the pointer,
// downloads the versioned copy into a staging directory and swaps it in as one, so an interrupted download never
// leaves a torn archive behind.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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

const prefixOf = (project: string, cfg: S3Config) => `${cfg.prefix}archive/${project}/`;
const POINTER = "current.json";
const VERSIONED = /^v(\d+)\//;

export type SyncResult = { project: string; sent: number; removed: number; skipped: number; version: number };

type Pointer = { project: string; version: number; head: string; at: string };

export async function pushArchive(
  project: string,
  options: { root?: string; s3?: S3Config } = {},
): Promise<SyncResult> {
  const cfg = options.s3 ?? s3FromEnv();
  const dir = archiveDir(project, options.root);
  const metaFile = path.join(dir, FILES.meta);
  if (!existsSync(metaFile)) throw new Error(`项目「${project}」没有档案：${dir}`);
  const meta = JSON.parse(readFileSync(metaFile, "utf8")) as { version: number; head: string; updatedAt?: string };
  const prefix = prefixOf(project, cfg);
  const versionPrefix = `${prefix}v${meta.version}/`;

  const remote = new Map(
    (await listObjects(cfg, versionPrefix)).map((item) => [item.key.slice(versionPrefix.length), item.etag]),
  );
  const files = walk(dir);
  let sent = 0,
    skipped = 0;
  for (const file of files) {
    const body = readFileSync(path.join(dir, file));
    if (remote.get(file) === md5(body)) {
      skipped += 1;
      continue;
    }
    // Versioned objects are immutable in effect: same key, same content. A failed PUT aborts the push and the
    // pointer never moves, so the half version stays inert.
    await putObject(cfg, `${versionPrefix}${file}`, body);
    sent += 1;
  }
  // The version must be whole before it goes live: every local file listed remotely.
  const left = new Set(files);
  for (const item of await listObjects(cfg, versionPrefix)) left.delete(item.key.slice(versionPrefix.length));
  if (left.size) throw new Error(`上传没传全，指针不动：还差 ${[...left].slice(0, 3).join("、")} 等 ${left.size} 个`);

  // Anything in the published version the local copy no longer has is stale; other versions are history, untouched.
  let removed = 0;
  const local = new Set(files);
  for (const key of remote.keys()) {
    if (local.has(key)) continue;
    await deleteObject(cfg, `${versionPrefix}${key}`);
    removed += 1;
  }
  // The pre-versioning layout kept files directly at the prefix; clear leftovers so a pull can't read ghosts.
  for (const item of await listObjects(cfg, prefix)) {
    const rel = item.key.slice(prefix.length);
    if (rel === POINTER || VERSIONED.test(rel)) continue;
    await deleteObject(cfg, item.key);
    removed += 1;
  }

  // All of v<N> is up: now, and only now, the pointer moves.
  const pointer: Pointer = {
    project,
    version: meta.version,
    head: meta.head,
    at: meta.updatedAt ?? new Date().toISOString(),
  };
  const body = Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`);
  const current = new Map((await listObjects(cfg, `${prefix}${POINTER}`)).map((item) => [item.key, item.etag]));
  if (current.get(`${prefix}${POINTER}`) !== md5(body)) {
    await putObject(cfg, `${prefix}${POINTER}`, body);
    sent += 1;
  } else {
    skipped += 1;
  }
  return { project, sent, removed, skipped, version: meta.version };
}

export async function pushAll(options: { root?: string; s3?: S3Config } = {}): Promise<SyncResult[]> {
  const cfg = options.s3 ?? s3FromEnv();
  const results: SyncResult[] = [];
  for (const { project } of listArchives(options.root)) {
    results.push(await pushArchive(project, { root: options.root, s3: cfg }));
  }
  return results;
}

/**
 * A read-only copy: the pointer says which version is whole; that version downloads into a staging directory and
 * replaces <to>/<project> in one rename. `options.version` pulls a specific published version instead of the
 * pointer's. A bucket still on the old flat layout is pulled as-is.
 */
export async function pullArchive(
  project: string,
  to: string,
  options: { s3?: S3Config; version?: number } = {},
): Promise<{ project: string; version: number; files: number }> {
  const cfg = options.s3 ?? s3FromEnv();
  const prefix = prefixOf(project, cfg);

  let version: number;
  let versionPrefix: string;
  if (options.version !== undefined) {
    version = options.version;
    versionPrefix = `${prefix}v${version}/`;
  } else {
    const body = await getObject(cfg, `${prefix}${POINTER}`);
    if (body === null) return pullFlat(project, to, cfg, prefix);
    const pointer = JSON.parse(body.toString("utf8")) as Pointer;
    version = pointer.version;
    versionPrefix = `${prefix}v${version}/`;
  }

  const objects = await listObjects(cfg, versionPrefix);
  if (!objects.length) throw new Error(`桶里没有项目「${project}」的档案 v${version}（${versionPrefix}）`);
  const staging = `${path.join(to, project)}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    for (const item of objects) {
      const rel = item.key.slice(versionPrefix.length);
      const body = await getObject(cfg, item.key);
      if (body === null) throw new Error(`下载到一半对象没了：${item.key}`);
      const target = path.join(staging, rel);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, body);
    }
    const meta = JSON.parse(readFileSync(path.join(staging, FILES.meta), "utf8")) as { version: number };
    const dir = path.join(to, project);
    rmSync(dir, { recursive: true, force: true });
    renameSync(staging, dir);
    return { project, version: meta.version, files: objects.length };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/** The pre-versioning layout: objects straight under the project prefix. */
async function pullFlat(project: string, to: string, cfg: S3Config, prefix: string) {
  const objects = (await listObjects(cfg, prefix)).filter((item) => {
    const rel = item.key.slice(prefix.length);
    return rel && rel !== POINTER && !VERSIONED.test(rel);
  });
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
