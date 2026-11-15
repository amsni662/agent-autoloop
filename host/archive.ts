// The archive sidecar: the shell that actually touches the archive on disk. The kernel only records — pending writes
// in `archive_writes`, a pointer snapshot in `archives`. This does the rest: it hands the snapshot to dispatch,
// applies each pending write with the store's own locking and dedup (the record's key rides in the commit, so a crash
// between commit and ack can only replay it as a duplicate), reports what landed, then pushes the new version to the
// bucket in the background. Everything here may fail without hurting dispatch: errors are recorded on the record.
import { iso, rows } from "../kernel/evolve.ts";
import { configuration } from "../kernel/query.ts";
import { NotFound } from "../kernel/errors.ts";
import { archiveRoot, readArchive, readArchiveAt, writeBack } from "../archive/store.ts";
import { pushAll, pushArchive } from "../archive/sync.ts";

type Hub = { execute(type: string, args: any[], now?: number): any; getView(): any };

const PUSH_DEBOUNCE = 3_000;
/** Besides the push each write-back schedules, everything goes up again on a slow timer. */
const PUSH_EVERY = 30 * 60_000;
/** A claim this old without an ack means the process holding it died. */
const STALE_AFTER = 60_000;

export function createArchiveSidecar(hub: Hub) {
  const root = archiveRoot();
  const marker = `${process.pid}`;
  let tick = 0;
  let queued = false;
  let closed = false;
  const pushes = new Map<string, NodeJS.Timeout>();
  let noCredentials = false;

  /** What dispatch puts in a job: each registered project's version, commit and summary as the archive on disk says. */
  function snapshot() {
    const found: Record<string, { version: number; summary: string; commit: string }> = {};
    const projects = Object.keys(configuration(hub.getView())?.projects ?? {});
    for (const project of projects) {
      try {
        const archive = readArchive(project, root);
        found[project] = { version: archive.version, summary: archive.summary, commit: archive.commit };
      } catch {
        // No archive on disk yet, or one being repaired: the job says version 0.
      }
    }
    return found;
  }

  /** What the worker door serves: the archive, or one version of it. */
  function archive(project: string, version?: number) {
    try {
      return version === undefined ? readArchive(project, root) : readArchiveAt(project, version, root);
    } catch {
      throw new NotFound(`项目「${project}」的档案没在这里`);
    }
  }

  function apply(rec: Record<string, any>) {
    const payload = JSON.parse(String(rec.payload));
    const base = () => readArchive(rec.project, root).version;
    const write =
      rec.kind === "receipt"
        ? { base: payload.base, log: payload.log, status: payload.status, decisions: payload.decisions }
        : rec.kind === "decision"
          ? { base: base(), decisions: payload.decisions }
          : { base: base(), log: payload.log };
    const result = writeBack(rec.project, write, { root, key: String(rec.key), by: rec.by ?? undefined });
    const archive = readArchive(rec.project, root);
    hub.execute("archiveDone", [
      rec.key,
      {
        version: result.version,
        summary: archive.summary,
        commit: result.commit,
        conflicts: result.conflicts,
        duplicate: result.duplicate === true,
      },
    ]);
    if (result.wrote) schedulePush(rec.project);
  }

  /** Take every pending write one at a time; a claim that fails means another process beat us to it. */
  function drain() {
    if (closed) return;
    hub.execute("archiveStale", [marker, iso(Date.now() - STALE_AFTER)]);
    // Receipts first: they're the only writes a stale base can refuse; the always-mergeable log and decision entries
    // of the same batch must not bump the version underneath them.
    const pending = rows(hub.getView(), "archive_writes", { state: "pending" }).sort(
      (a, b) => Number(b.kind === "receipt") - Number(a.kind === "receipt"),
    );
    for (const rec of pending) {
      if (closed) return;
      if (!hub.execute("archiveClaim", [String(rec.key), `${marker}:${tick++}`])) continue;
      try {
        apply(rec);
      } catch (error) {
        hub.execute("archiveDone", [String(rec.key), { error: String((error as Error)?.message ?? error) }]);
      }
    }
  }

  /** Called on every kernel change: pending writes are worked through a moment later, off the request path. */
  function kick() {
    if (queued || closed) return;
    queued = true;
    setImmediate(() => {
      queued = false;
      try {
        drain();
      } catch (error) {
        console.error("档案写回出错了：", error);
      }
    });
  }

  /** A write-back just landed: its version goes to the bucket shortly after, without holding dispatch up. */
  function schedulePush(project: string) {
    if (closed || noCredentials) return;
    clearTimeout(pushes.get(project));
    pushes.set(
      project,
      setTimeout(() => {
        pushes.delete(project);
        void pushAllProjects(project);
      }, PUSH_DEBOUNCE),
    );
  }

  async function pushAllProjects(only?: string) {
    try {
      const results = only ? [await pushArchive(only, { root })] : await pushAll({ root });
      for (const result of results) {
        hub.execute("archivePushed", [result.project, { version: result.version }]);
      }
    } catch (error) {
      const missing = /ARCHIVE_S3_/.test(String((error as Error)?.message ?? ""));
      if (missing) noCredentials = true;
      if (only) {
        hub.execute("archivePushed", [only, { error: String((error as Error)?.message ?? error) }]);
      }
    }
  }

  const periodic = setInterval(() => {
    if (closed || noCredentials) return;
    void pushAllProjects();
  }, PUSH_EVERY);
  periodic.unref();

  return {
    snapshot,
    archive,
    kick,
    close() {
      closed = true;
      clearInterval(periodic);
      for (const timer of pushes.values()) clearTimeout(timer);
    },
  };
}

export type ArchiveSidecar = ReturnType<typeof createArchiveSidecar>;
