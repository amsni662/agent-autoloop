// What this device spent that the hub never dispatched: the worker reads its machine's own counters — a request log
// a local gateway appends to, the session files its agents write, a quota snapshot — and keeps only the numbers.
// Words in those files are never stored or sent; the hub gets day totals and nothing else. Sessions this worker
// itself launched are left out: the hub already has that spend from the runs' receipts, and counting them again
// would count it twice.
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { MeterSource } from "../host/config.ts";
import { HOME } from "../host/home.ts";
import { dateTime, type QuotaRow, type UsageReport, type UsageRow } from "../protocol/validate.ts";

const STATE_FILE = path.join(HOME, "worker", "metering.json");
/** Sources are looked at this often; each look reads only what a file grew by. */
const SCAN_EVERY = 15_000;
/** A report goes at most this often, and only when something changed since the last one the hub took. */
const SEND_EVERY = 60_000;
/** How much of a file one look reads; the rest is next look's, so a busy log never stalls a scan. */
const CHUNK = 8 * 1024 * 1024;
/** Days the hub already took are kept this long, then dropped from the local state. */
const KEEP_DAYS = 45;
const KEEP_SESSIONS = 500;
const REPORT_DAYS = 62;

type Counted = { input: number; output: number; cache_read: number; cache_write: number; runs: number };
type FileMark = {
  offset: number;
  /** A cumulative reader's last seen totals: what counts is how far they rose, never the totals themselves. */
  prev?: { input: number; output: number; cached: number };
  model?: string;
  skip?: boolean;
  /** A file read whole is read again when this pair moved. */
  size?: number;
  mtime?: number;
};
type MeterState = {
  files: Record<string, FileMark>;
  days: Record<string, Record<string, Counted>>;
  sessions: Record<string, string[]>;
  quotas?: QuotaRow[];
  dirty: string[];
};

function loadState(): MeterState {
  try {
    return { files: {}, days: {}, sessions: {}, dirty: [], ...JSON.parse(readFileSync(STATE_FILE, "utf8")) };
  } catch {
    return { files: {}, days: {}, sessions: {}, dirty: [] };
  }
}
function save(state: MeterState) {
  mkdirSync(path.dirname(STATE_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(state), { mode: 0o600 });
  renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
}
const expand = (file: string) => file.replace(/^~(?=[/\\])/, homedir());
/** The device's own day: a worker may live in another zone than the hub, and its day is the honest one to bucket by. */
const dateOf = (ms: number) => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
const isItem = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value);

export function createMeter({
  send,
  sources,
  log = () => {},
  now = Date.now,
}: {
  send: (report: UsageReport) => Promise<unknown>;
  sources: MeterSource[];
  log?: (line: string) => void;
  now?: () => number;
}) {
  const state = loadState();
  const dirty = new Set(state.dirty);
  let quotaDirty = state.quotas !== undefined;
  let scanned = 0;
  let sentAt = 0;

  /** State is written often enough that a restart resends the same day at worst — and the hub's whole-day replace
   * makes that a retry, not a double. */
  const persist = () => {
    state.dirty = [...dirty];
    save(state);
  };

  /** A session this worker launched: its spend reaches the hub on the run's receipt, not through this meter. */
  const launched = (use: string, session: string) => {
    if (!session) return;
    const list = (state.sessions[use] ??= []);
    if (list.includes(session)) return;
    list.push(session);
    if (list.length > KEEP_SESSIONS) list.shift();
    persist();
  };
  const excluded = (use: string | undefined, session: string) =>
    use !== undefined && (state.sessions[use] ?? []).includes(session);

  function count(date: string, agent: string, model: string, source: string, add: Counted) {
    const day = (state.days[date] ??= {});
    const row = (day[`${agent || "?"}|${model || "?"}|${source}`] ??= {
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
      runs: 0,
    });
    row.input += add.input;
    row.output += add.output;
    row.cache_read += add.cache_read;
    row.cache_write += add.cache_write;
    row.runs += add.runs;
    dirty.add(date);
  }

  /** The lines a file grew by since the last look. A half-written last line is read when its rest arrives; a file
   * that shrank is read from the start again, since what it held is gone. */
  function appended(file: string, mark: FileMark): string[] {
    const size = statSync(file).size;
    if (size < mark.offset) {
      mark.offset = 0;
      delete mark.prev;
      delete mark.model;
      delete mark.skip;
    }
    if (size === mark.offset) return [];
    const length = Math.min(size - mark.offset, CHUNK);
    const fd = openSync(file, "r");
    try {
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, mark.offset);
      const text = buffer.toString("utf8");
      const end = text.lastIndexOf("\n");
      if (end < 0) return [];
      mark.offset += Buffer.byteLength(text.slice(0, end + 1));
      return text.slice(0, end).split("\n");
    } finally {
      closeSync(fd);
    }
  }

  function scanGateway(source: Extract<MeterSource, { kind: "gateway" }>) {
    const file = expand(source.file);
    if (!existsSync(file)) return;
    const mark = (state.files[file] ??= { offset: 0 });
    for (const line of appended(file, mark)) {
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const at = Date.parse(entry?.t ?? "");
      if (!Number.isFinite(at)) continue;
      // Traffic a run of this worker's made: its receipt counts it already.
      const session = String(entry.native_session ?? entry.session ?? "");
      if (session && excluded(String(entry.agent ?? ""), session)) continue;
      count(dateOf(at), String(entry.agent ?? "?"), String(entry.model ?? "?"), source.kind, {
        input: num(entry.in),
        output: num(entry.out),
        cache_read: num(entry.cache_read),
        cache_write: num(entry.cache_write),
        runs: 1,
      });
    }
  }

  /** A session file's id is in its name: `<id>.jsonl`, or a rollout's trailing `<id>.jsonl`. */
  const sessionOf = (file: string) => {
    const base = path.basename(file, path.extname(file));
    return /[0-9a-f]{8}-[0-9a-f-]{27,}/i.exec(base)?.[0] ?? base;
  };

  /** The numeric usage one session-file line carries, whichever shape it has; nothing else of the line is kept. */
  function usageIn(line: string, mark: FileMark): { at: number; model?: string; counted: Counted } | null {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      return null;
    }
    if (!entry || typeof entry !== "object") return null;
    // A message that reports what it used outright.
    const usage = entry.message?.usage;
    if (usage && typeof usage === "object") {
      const at = Date.parse(entry.timestamp ?? "");
      if (!Number.isFinite(at)) return null;
      return {
        at,
        model: typeof entry.message?.model === "string" ? entry.message.model : undefined,
        counted: {
          input: num(usage.input_tokens),
          output: num(usage.output_tokens),
          cache_read: num(usage.cache_read_input_tokens),
          cache_write: num(usage.cache_creation_input_tokens),
          runs: 1,
        },
      };
    }
    const payload = entry.payload;
    if (payload?.type === "token_count") {
      const total = payload.info?.total_token_usage;
      const at = Date.parse(entry.timestamp ?? "");
      if (!total || typeof total !== "object" || !Number.isFinite(at)) return null;
      const prev = mark.prev ?? { input: 0, output: 0, cached: 0 };
      const current = {
        input: num(total.input_tokens),
        output: num(total.output_tokens),
        cached: num(total.cached_input_tokens),
      };
      const cached = Math.max(0, current.cached - prev.cached);
      mark.prev = {
        input: Math.max(prev.input, current.input),
        output: Math.max(prev.output, current.output),
        cached: Math.max(prev.cached, current.cached),
      };
      return {
        at,
        // The running input already has the cached part in it; the reported split keeps them disjoint.
        counted: {
          input: Math.max(0, current.input - prev.input - cached),
          output: Math.max(0, current.output - prev.output),
          cache_read: cached,
          cache_write: 0,
          runs: 1,
        },
      };
    }
    if (typeof payload?.model === "string") mark.model = payload.model;
    return null;
  }

  function scanSessions(source: Extract<MeterSource, { kind: "sessions" }>) {
    const dir = expand(source.dir);
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir, { recursive: true })) {
      const file = path.join(dir, String(name));
      if (!file.endsWith(".jsonl")) continue;
      const mark = (state.files[file] ??= { offset: 0 });
      if (mark.skip) continue;
      if (excluded(source.use ?? source.agent, sessionOf(file))) {
        mark.skip = true;
        continue;
      }
      for (const line of appended(file, mark)) {
        const found = usageIn(line, mark);
        if (!found) continue;
        count(dateOf(found.at), source.agent, found.model ?? mark.model ?? "?", source.kind, found.counted);
      }
    }
  }

  /** A quota file is small enough to read whole: each provider/account keeps window rows as the snapshot shows them. */
  function scanQuota(source: Extract<MeterSource, { kind: "quota" }>) {
    const file = expand(source.file);
    const mark = (state.files[file] ??= { offset: 0 });
    if (!existsSync(file)) {
      if (state.quotas?.length) {
        state.quotas = [];
        quotaDirty = true;
      }
      return;
    }
    const { size, mtimeMs } = statSync(file);
    if (mark.size === size && mark.mtime === mtimeMs) return;
    mark.size = size;
    mark.mtime = mtimeMs;
    let top: any = {};
    try {
      top = JSON.parse(readFileSync(file, "utf8"));
    } catch {}
    const parsed: QuotaRow[] = [];
    for (const [name, entry] of Object.entries<any>(top ?? {})) {
      const split = [name.indexOf("|"), name.indexOf("/")].find((i) => i >= 0) ?? -1;
      const provider = (fallback?: unknown) => String(fallback ?? (split >= 0 ? name.slice(0, split) : name));
      const account = split >= 0 ? name.slice(split + 1) : "";
      const quota = entry?.quota ?? entry;
      const at = dateTime(entry?.at) ? entry.at : undefined;
      if (Array.isArray(quota?.windows)) {
        // A snapshot file: window rows as the provider last said them.
        for (const window of quota.windows) {
          const used = num(window?.used);
          if (used > 100 || !dateTime(window?.resetsAt)) continue;
          parsed.push({
            provider: provider(quota?.provider),
            account,
            ...(typeof quota?.plan === "string" && { plan: quota.plan }),
            window: String(window.name ?? "?"),
            used_pct: used,
            resets_at: window.resetsAt,
            ...(at && { at }),
          });
        }
      } else if (isItem(entry)) {
        // A history file: window name → samples; the freshest of each is the state now.
        for (const [windowName, samples] of Object.entries<any>(entry)) {
          if (!Array.isArray(samples)) continue;
          const last = samples.findLast((s: any) => dateTime(s?.resetsAt));
          if (!last) continue;
          parsed.push({
            provider: provider(undefined),
            account,
            window: windowName,
            used_pct: Math.min(100, Math.max(0, 100 - num(last.left))),
            resets_at: last.resetsAt,
            ...(dateTime(last.at) && { at: last.at }),
          });
        }
      }
    }
    if (JSON.stringify(parsed) !== JSON.stringify(state.quotas)) {
      state.quotas = parsed;
      quotaDirty = true;
    }
  }

  /** The days not yet handed in, newest first; the hub replaces each day's partition with what it gets. */
  function report() {
    const dates = [...dirty].sort().reverse().slice(0, REPORT_DAYS);
    return {
      dates,
      body: {
        days: dates.map((date) => ({
          date,
          rows: Object.entries(
            // Keys written before empty names were normalized still sit in state; fold them into "?" here.
            Object.entries(state.days[date]).reduce(
              (rows, [key, counted]) => {
                const [agent, model, source] = key.split("|").map((part) => part || "?");
                const row = (rows[`${agent}|${model}|${source}`] ??= {
                  agent,
                  model,
                  source,
                  input: 0,
                  output: 0,
                  cache_read: 0,
                  cache_write: 0,
                  runs: 0,
                });
                for (const name of ["input", "output", "cache_read", "cache_write", "runs"] as const)
                  row[name] += counted[name];
                return rows;
              },
              {} as Record<string, UsageRow>,
            ),
          ).map(([, row]) => row),
        })),
        ...(state.quotas !== undefined && { quotas: state.quotas }),
      } as UsageReport,
    };
  }

  function prune(moment: number) {
    const floor = dateOf(moment - KEEP_DAYS * 86400_000);
    for (const date of Object.keys(state.days)) if (date < floor && !dirty.has(date)) delete state.days[date];
    for (const file of Object.keys(state.files)) if (!existsSync(file)) delete state.files[file];
  }

  async function tick() {
    const moment = now();
    if (moment - scanned >= SCAN_EVERY) {
      scanned = moment;
      for (const source of sources) {
        try {
          if (source.kind === "gateway") scanGateway(source);
          else if (source.kind === "sessions") scanSessions(source);
          else if (source.kind === "quota") scanQuota(source);
        } catch (error) {
          const where = (source as { file?: string; dir?: string }).file ?? (source as { dir?: string }).dir;
          log(`meter: couldn't read ${source.kind} ${where}: ${error}`);
        }
      }
      prune(moment);
      if (dirty.size || quotaDirty) persist();
    }
    if ((!dirty.size && !quotaDirty) || moment - sentAt < SEND_EVERY) return;
    const { dates, body } = report();
    try {
      await send(body);
      for (const date of dates) dirty.delete(date);
      quotaDirty = false;
      sentAt = now();
      persist();
    } catch (error) {
      log(`meter: couldn't report usage: ${error}`);
    }
  }

  return { launched, tick };
}

export type Meter = ReturnType<typeof createMeter>;
