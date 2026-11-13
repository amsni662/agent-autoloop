// `agent-autoloop archive`: look at a project's archive, write back, and run one sync by hand. The data lives under the
// machine's own archive store; bucket credentials come from secrets.env or the environment, never from arguments.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { HOME } from "../host/home.ts";
import { pullArchive, pushAll, pushArchive } from "./sync.ts";
import { initArchive, listArchives, readArchive, readArchiveAt, writeBack } from "./store.ts";

// The full usage is in cli/main.ts (TAKES.archive.usage); errors here say enough to retry.
const USAGE_LINE = "用法见：agent-autoloop archive --help（动作：show、init、write、sync、pull）";

const fail = (words: string): never => {
  console.error(words);
  process.exit(1);
};

function named(args: string[]) {
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) rest.push(args[i]);
    else if (args[i + 1] !== undefined && !args[i + 1].startsWith("--")) flags[args[i].slice(2)] = args[++i];
    else flags[args[i].slice(2)] = true;
  }
  return { flags, rest };
}

const text = (value: string | true | undefined) => (typeof value === "string" ? value : undefined);

/** secrets.env holds the bucket credentials on a machine that has them, like the hub's own webhook secrets. */
function loadSecrets() {
  const file = path.join(HOME, "secrets.env");
  if (existsSync(file)) process.loadEnvFile(file);
}

function show(project: string, flags: Record<string, string | true>) {
  const version = text(flags.version);
  if (version !== undefined && !/^\d+$/.test(version)) fail(USAGE_LINE);
  const read = version === undefined ? readArchive(project) : readArchiveAt(project, Number(version));
  const lines = [
    `项目「${read.project}」版本 ${read.version}（提交 ${read.commit.slice(0, 12)}）`,
    `摘要：${read.summary || "（空）"}`,
    `文件：${["档案.json", "说明书.md", "状态.md", "日志.md", "决定.md"].join("、")}；检查点 ${read.checkpoints.length} 个`,
    "",
    "--- 状态.md ---",
    read.status.trimEnd() || "（空）",
  ];
  console.log(lines.join("\n"));
}

function write(project: string) {
  let input: { base?: unknown; log?: unknown; status?: unknown; decisions?: unknown };
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return fail(`写回的 JSON 从标准输入传，形如：{"base":0,"log":["…"],"status":"…","decisions":["…"]}`);
  }
  if (typeof input !== "object" || input === null) return fail("写回要是一个 JSON 对象。");
  const result = writeBack(project, input as Parameters<typeof writeBack>[1], { by: "命令行" });
  if (!result.wrote) {
    fail(
      `没写回：读到的版本（${(input.base as number) ?? "?"}）已经落后（现在 ${result.version}），` +
        "能合并的也没有了，状态冲突留给了本人确认。",
    );
  }
  console.log(`写回了：项目「${project}」版本 ${result.version}（提交 ${result.commit.slice(0, 12)}）。`);
  if (result.conflicts.includes("status")) {
    console.error(
      `注意：状态没写回——写回基于版本 ${JSON.stringify(input.base)}，档案已经到 ${result.version}；` +
        "确认后按现在的版本号重交一次。",
    );
    process.exitCode = 1;
  }
}

export async function archiveCommand(args: string[]) {
  const { flags, rest } = named(args);
  const [action, project] = rest;
  if (action === undefined || action === "list") {
    const archives = listArchives();
    if (!archives.length)
      return console.log("还没有档案。规则里登记项目后，第一轮写回会自动建档；也可 archive init <项目> 先建。");
    for (const item of archives) console.log(`${item.project}\t版本 ${item.version}`);
    return;
  }
  if (!project || rest.length > 2) fail(USAGE_LINE);
  switch (action) {
    case "init": {
      const made = initArchive(project);
      return console.log(`建档了：项目「${project}」版本 0（提交 ${made.commit.slice(0, 12)}）。`);
    }
    case "show":
      return show(project, flags);
    case "write":
      return write(project);
    case "sync": {
      loadSecrets();
      if (project) {
        const r = await pushArchive(project);
        return console.log(`项目「${r.project}」：传了 ${r.sent} 个对象，删了 ${r.removed} 个，跳过 ${r.skipped} 个。`);
      }
      const results = await pushAll();
      if (!results.length) return console.log("没有档案可同步。");
      for (const r of results)
        console.log(`项目「${r.project}」：传了 ${r.sent} 个对象，删了 ${r.removed} 个，跳过 ${r.skipped} 个。`);
      return;
    }
    case "pull": {
      const to = text(flags.to);
      if (!to) return fail("archive pull 要写拉到哪：--to <目录>");
      loadSecrets();
      const pulled = await pullArchive(project, to);
      return console.log(
        `拉好了：项目「${pulled.project}」版本 ${pulled.version}，${pulled.files} 个文件在 ${path.join(to, project)}。`,
      );
    }
    default:
      fail(USAGE_LINE);
  }
}
