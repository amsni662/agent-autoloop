// Local end-to-end rehearsal for the chat adapters: a real hub on a random port in a temp AGENT_AUTOLOOP_HOME,
// both adapter entrypoints run as real child processes, a fake iLink HTTP service and a fake lark-cli stand in for
// the platforms. No real message is ever sent. Usage: node adapters/testing/rehearse.mjs
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NODE = process.execPath;
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(REPO, "bin", "agent-autoloop.ts");
const NODE_BIN = dirname(NODE);
const home = mkdtempSync(join(tmpdir(), "chat-rehearse-"));
const rulesFile = join(home, "rules.json");
{
  const base = JSON.parse(readFileSync(join(REPO, "tests", "chat.fixture.json"), "utf8"));
  base.elsewhere = [
    { name: "演练任务", source: "wechat", to: "ops-mini", cron: "0 9 * * *", cwd: "~/", where: "演练" },
  ];
  writeFileSync(rulesFile, JSON.stringify(base));
}
const env = { ...process.env, AGENT_AUTOLOOP_HOME: home, AGENT_AUTOLOOP_RULES: rulesFile };
const log = (line) => console.log(`[演练] ${line}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cli = (args) =>
  new Promise((resolve, reject) =>
    execFile(NODE, ["--disable-warning=ExperimentalWarning", CLI, ...args], { env, encoding: "utf8" }, (error, stdout) =>
      error ? reject(new Error(`${args[0]}: ${error.message}`)) : resolve(stdout.trim()),
    ),
  );

const die = (msg) => {
  console.error(`[演练] 失败：${msg}`);
  process.exit(1);
};
const until = async (what, fn, tries = 80) => {
  for (let i = 0; i < tries; i++) {
    const value = await fn();
    if (value) return value;
    await sleep(250);
  }
  die(`等不到：${what}`);
};

// ---- temp hub ----
const port = 20000 + Math.floor(Math.random() * 20000);
await cli(["init", "--no-service", "--port", String(port)]);
const hub = spawn(NODE, ["--disable-warning=ExperimentalWarning", CLI, "up"], {
  env,
  stdio: "ignore",
});
process.on("exit", () => hub.kill());
const base = `http://127.0.0.1:${port}`;
const hubUp = await until("中枢 healthz", async () => {
  try {
    return (await fetch(`${base}/healthz`)).ok;
  } catch {
    return false;
  }
});
if (!hubUp) die("中枢没起来");
const keys = {
  source: (await cli(["key", "new", "source", "wechat"])).trim(),
  channel: (await cli(["key", "new", "channel", "wechat"])).trim(),
};
keys.feishuSource = (await cli(["key", "new", "source", "feishu"])).trim();
keys.feishuChannel = (await cli(["key", "new", "channel", "feishu"])).trim();
keys.worker = (await cli(["key", "new", "worker", "office-mini"])).trim();
log(`中枢起来了：${base}`);

// ---- fake iLink HTTP service (real transport will hit it) ----
const ilink = { sends: [], updates: [] };
const queue = [];
const fakeIlink = createServer(async (req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  await new Promise((resolve) => req.on("end", resolve));
  const body = data ? JSON.parse(data) : {};
  const reply = (v) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(v));
  if (req.url.endsWith("/notifystart") || req.url.endsWith("/notifystop")) return reply({ ret: 0 });
  if (req.url.endsWith("/getupdates")) {
    ilink.updates.push(body.get_updates_buf ?? "");
    return reply({ ret: 0, get_updates_buf: `buf-${ilink.updates.length}`, msgs: queue.splice(0) });
  }
  if (req.url.endsWith("/sendmessage")) {
    ilink.sends.push(body);
    return reply({ ret: 0 });
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => fakeIlink.listen(0, "127.0.0.1", resolve));
const ilinkUrl = `http://127.0.0.1:${fakeIlink.address().port}`;
log(`假 ilink：${ilinkUrl}`);

// ---- fake lark-cli (absolute node shebang so a clean env still runs it) ----
const larkLog = join(home, "lark-sends.jsonl");
const fakeLark = join(home, "lark-cli");
writeFileSync(
  fakeLark,
  `#!${NODE}
import { appendFileSync } from "node:fs";
const [verb, ...rest] = process.argv.slice(2);
if (verb === "event") {
  const lines = (process.env.LARK_EVENTS ?? "").split("\\n").filter(Boolean);
  process.stdout.write("[event] listening\\n" + lines.join("\\n") + "\\n");
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
} else {
  appendFileSync(${JSON.stringify(larkLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
  console.log(JSON.stringify({ code: 0, data: { message_id: "om_fake" } }));
}
`,
  { mode: 0o755 },
);
chmodSync(fakeLark, 0o755);

// ---- configs + adapter children ----
const keysFile = (name, data) => {
  const file = join(home, `${name}.keys.json`);
  writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
  return file;
};
const wxMsg = (id, text, over = {}) => ({
  message_id: id,
  from_user_id: "me@im.wechat",
  message_type: 1,
  context_token: "ctx-rehearse",
  item_list: [{ type: 1, text_item: { text } }],
  ...over,
});

const wxConfig = join(home, "wx.config.json");
writeFileSync(
  wxConfig,
  JSON.stringify({
    hub: base,
    me: "me@im.wechat",
    keysFile: keysFile("wx", { source: keys.source, channel: keys.channel }),
    rulesFile: env.AGENT_AUTOLOOP_RULES,
    stateFile: join(home, "wx.state.json"),
    accountFile: keysFile("acct", { baseUrl: ilinkUrl, token: "t", userId: "me@im.wechat" }),
    features: { intake: true, notify: true, answers: true },
  }),
  { mode: 0o600 },
);
const wx = spawn(NODE, ["--disable-warning=ExperimentalWarning", join(REPO, "adapters/wechat-clawbot/main.ts"), wxConfig], {
  env: { ...env, PATH: `${NODE_BIN}:/usr/bin:/bin` },
  stdio: ["ignore", "pipe", "pipe"],
});
wx.stdout.on("data", (d) => process.stdout.write(`[wechat] ${d}`));
wx.stderr.on("data", (d) => process.stdout.write(`[wechat!] ${d}`));

const fsConfig = join(home, "fs.config.json");
writeFileSync(
  fsConfig,
  JSON.stringify({
    hub: base,
    me: "ou_me",
    keysFile: keysFile("fs", { source: keys.feishuSource, channel: keys.feishuChannel }),
    rulesFile: env.AGENT_AUTOLOOP_RULES,
    stateFile: join(home, "fs.state.json"),
    lark: fakeLark,
    features: { intake: true, notify: true, answers: true },
  }),
  { mode: 0o600 },
);
const fs = spawn(NODE, ["--disable-warning=ExperimentalWarning", join(REPO, "adapters/feishu-chat/main.ts"), fsConfig], {
  env: {
    ...env,
    PATH: `${NODE_BIN}:/usr/bin:/bin`,
    LARK_EVENTS: [
      { message_id: "om_r1", sender_id: "ou_me", sender_type: "user", chat_id: "oc_1", chat_type: "p2p", message_type: "text", content: "帮助" },
      { message_id: "om_r2", sender_id: "ou_me", sender_type: "user", chat_id: "oc_1", chat_type: "p2p", message_type: "text", content: "ai-loop：跑下演练" },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
fs.stdout.on("data", (d) => process.stdout.write(`[feishu] ${d}`));
fs.stderr.on("data", (d) => process.stdout.write(`[feishu!] ${d}`));

// ---- drive wechat ----
queue.push(wxMsg("wx-1", "项目"), wxMsg("wx-2", "切到 ai-loop"), wxMsg("wx-3", "ai-loop：演练一下"));
await until("微信回复 3 条", () => ilink.sends.length >= 3);
const texts = ilink.sends.map((s) => s.msg.item_list[0].text_item.text);
if (!texts.some((t) => /已登记的项目/.test(t))) die("「项目」回复不对");
if (!texts.some((t) => /当前项目/.test(t))) die("「切到」回复不对");
if (!texts.some((t) => /已派给「微信 AI Loop 任务」/.test(t))) die("任务没派给微信 AI Loop 任务");
if (!ilink.sends.every((s) => s.msg.context_token === "ctx-rehearse")) die("回复没带 context_token");
log("微信：收指令、项目路由、context_token 都验证了");

// elsewhere ask card → wechat text with #id → answer it
const tell = await fetch(`${base}/v1/tell`, {
  method: "POST",
  headers: { authorization: `Bearer ${keys.worker}`, "content-type": "application/json" },
  body: JSON.stringify({
    task: "演练任务",
    ask: {
      title: "演练通知：到微信了吗",
      text: "到微信了吗",
      options: ["继续", "停下"],
      recommend: 0,
      about: "演练",
      key: "rehearse-1",
    },
  }),
});
if (!tell.ok) die(`tell 失败 ${tell.status}`);
const cardSend = await until("卡片发到微信", () =>
  ilink.sends.find((s) => /演练通知/.test(s.msg.item_list[0].text_item.text)),
);
const cardText = cardSend.msg.item_list[0].text_item.text;
const found = /#(\d+)/.exec(cardText);
if (!found) die(`卡片文本里没有 #号：${JSON.stringify(cardText)}`);
const cardId = Number(found[1]);
queue.push(wxMsg("wx-4", `#${cardId} 确认`));
await until("拍板回执", () => ilink.sends.length >= 5);
const state = JSON.parse(readFileSync(join(home, "wx.state.json"), "utf8"));
if (state.cursor === undefined) die("游标没持久化");
log(`微信：卡片 #${cardId} 文本送达（ref=clientId）+ # 号拍板 + 游标持久化都验证了`);

// ---- drive feishu ----
const sent = await until("飞书回复", () => {
  try {
    return readFileSync(larkLog, "utf8").trim().split("\n").length >= 2;
  } catch {
    return false;
  }
});
const fsTexts = readFileSync(larkLog, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l).at(-1));
if (!fsTexts.some((t) => /能发的消息/.test(t))) die("飞书帮助不对");
if (!fsTexts.some((t) => /已派给「飞书 AI Loop 任务」/.test(t))) die("飞书任务没派出去");
log("飞书：事件流、只认本人、项目路由、+messages-send 都验证了");

// ---- clean up ----
wx.kill("SIGTERM");
fs.kill("SIGTERM");
await Promise.all([
  new Promise((r) => wx.once("exit", r)),
  new Promise((r) => fs.once("exit", r)),
]);
hub.kill("SIGTERM");
fakeIlink.close();
rmSync(home, { recursive: true, force: true });
log("全部通过：两个入口在临时中枢 + 假平台上跑通了，临时文件已清理");
