// `agent-autoloop usage`: every device's model spend, by day, device, agent and model — reported usage plus what the
// hub dispatched (source "runs"), in the same all-input accounting as `spending` (input includes the cache, which
// shows as a percentage). Quota windows each device last read come along for the ride.
import { clockFor } from "./status.ts";

type Totals = { input: number; output: number; cached: number; cost: number; runs: number };
type Row = {
  device: string;
  date: string;
  agent: string;
  model: string;
  source: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  runs: number;
  cost?: number;
};
export type UsageView = {
  now: string;
  timezone: string;
  since: string;
  until: string;
  days: { date: string; devices: Record<string, Totals>; total: Totals }[];
  devices: Record<string, Totals>;
  total: Totals;
  rows: Row[];
  quotas: {
    device: string;
    provider: string;
    account: string;
    plan?: string;
    window: string;
    used_pct: number;
    resets_at: string;
    at?: string;
  }[];
};

const count = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("zh-CN");
const tokens = (n: number) => `${count.format(n).replace(/(万|亿)/, " $1")} Token`;

/** One row's spend in the all-input convention: a reported row's input leaves the cache out, a run's has it in. */
const counted = (row: Row): Totals => ({
  input: row.input + (row.source === "runs" ? 0 : row.cache_read + row.cache_write),
  output: row.output,
  cached: row.cache_read,
  cost: row.cost ?? 0,
  runs: row.runs,
});

const add = (into: Totals, more: Totals) => {
  into.input += more.input;
  into.output += more.output;
  into.cached += more.cached;
  into.cost += more.cost;
  into.runs += more.runs;
};
const blank = (): Totals => ({ input: 0, output: 0, cached: 0, cost: 0, runs: 0 });

/** Input already has the cache in it, so the share shows how much was cheap reads — the `spending` wording. */
const line = (t: Totals) => {
  const all = t.input + t.output;
  if (!all && !t.runs) return "0 Token";
  const cache = all > 0 && t.cached > 0 ? `（缓存 ${Math.round((t.cached / all) * 100)}%）` : "";
  const cost = t.cost > 0 ? ` · $${t.cost.toFixed(2)}` : "";
  return `${tokens(all)}${cache} · ${whole.format(t.runs)} 次${cost}`;
};

/** Rows grouped to `key → totals`, biggest first, `top` of them named and the rest folded into 其他. */
function byKey(rows: Row[], key: (row: Row) => string, top = 4) {
  const groups = new Map<string, Totals>();
  for (const row of rows) {
    const name = key(row) || "未记";
    add((groups.get(name) ?? groups.set(name, blank()).get(name))!, counted(row));
  }
  const sorted = [...groups].sort((a, b) => b[1].input + b[1].output - (a[1].input + a[1].output));
  const shown = sorted
    .slice(0, top)
    .map(([name, t]) => `${name} ${count.format(t.input + t.output).replace(/(万|亿)/, " $1")}`);
  const rest = sorted.slice(top);
  if (rest.length) {
    const folded = blank();
    for (const [, t] of rest) add(folded, t);
    shown.push(`其他 ${count.format(folded.input + folded.output).replace(/(万|亿)/, " $1")}`);
  }
  return shown;
}

export function usageText(view: UsageView, { days }: { days: number }) {
  const { when } = clockFor(view);
  const lines: string[] = [];
  const today = view.days.find((day) => day.date === view.until);
  const todayRows = view.rows.filter((row) => row.date === view.until);
  const block = (title: string, devices: Record<string, Totals>, total: Totals, rows: Row[]) => {
    lines.push(title);
    lines.push(`  总共    ${line(total)}`);
    const names = Object.keys(devices).sort(
      (a, b) => devices[b].input + devices[b].output - (devices[a].input + devices[a].output),
    );
    const room = Math.max(4, ...names.map((name) => name.length));
    for (const device of names) lines.push(`  ${device.padEnd(room)} ${line(devices[device])}`);
    for (const [label, key] of [
      ["Agent", (row: Row) => row.agent],
      ["模型", (row: Row) => row.model],
      ["来源", (row: Row) => row.source],
    ] as const) {
      const parts = byKey(rows, key);
      if (parts.length) lines.push(`  ${label.padEnd(6)} ${parts.join(" · ")}`);
    }
  };
  if (today) block(`今天（${today.date}）`, today.devices, today.total, todayRows);
  else lines.push(`今天（${view.until}）还没有用量记录。`);
  if (days > 1) {
    block(`最近 ${days} 天（${view.since} 至 ${view.until}）`, view.devices, view.total, view.rows);
    const perDay = view.days
      .map(
        (day) => `${day.date.slice(5)} ${count.format(day.total.input + day.total.output).replace(/(万|亿)/, " $1")}`,
      )
      .join(" · ");
    if (perDay) lines.push(`  每天    ${perDay}`);
  }
  if (view.quotas.length) {
    lines.push("额度");
    for (const quota of view.quotas) {
      const left = Math.max(0, Math.round(100 - quota.used_pct));
      const plan = quota.plan && quota.plan !== quota.account ? `（${quota.plan}）` : "";
      const account = quota.account ? `/${quota.account}` : "";
      lines.push(
        `  ${quota.device} · ${quota.provider}${account}${plan} · ${quota.window} 剩 ${left}% · ${when(quota.resets_at)} 重置`,
      );
    }
  }
  return lines.join("\n");
}
