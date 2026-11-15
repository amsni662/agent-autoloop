// The real WeChat ClawBot entry, run as a process the way launchd runs it. Guards the failure T15 found: the
// entry dying at startup because the transport package can't be resolved — not just injected IO in unit tests. A
// fixture transportDir holds a package-shaped transport speaking the real iLink HTTP endpoints at a fake server,
// so the test covers real module resolution, real config/account loading, the two loops, and a clean SIGTERM.
import assert from "node:assert/strict";
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";
import { inboundText, startFakeIlink } from "./chat-ilink.fake.ts";

const dir = setup("chat-entry", join(import.meta.dirname, "chat.fixture.json"));
const { serve } = await import("../host/http.ts");
const hubFns = await import("./hub.ts");

const server = serve(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}`;

const ilink = await startFakeIlink();
const children: ChildProcess[] = [];
after(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  ilink.close();
  server.closeAllConnections();
  server.close();
});

// A package-shaped stand-in for @tencent-weixin/openclaw-weixin: dist/src/api/api.js + messaging/send.js calling
// the same endpoints the real transport calls. It lives under a directory the config's transportDir points at.
const transportDir = join(dir, "transport-package");
for (const [file, body] of [
  [
    "api/api.js",
    `const post = async (baseUrl, path, body) => {
  const res = await fetch(baseUrl + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error("ilink " + path + ": " + res.status);
  return res.json();
};
export const notifyStart = ({ baseUrl }) => post(baseUrl, "/ilink/bot/notifystart", {});
export const notifyStop = ({ baseUrl }) => post(baseUrl, "/ilink/bot/notifystop", {});
export const getUpdates = ({ baseUrl, get_updates_buf }) => post(baseUrl, "/ilink/bot/getupdates", { get_updates_buf });`,
  ],
  [
    "messaging/send.js",
    `export const sendMessageWeixin = async ({ to, text, opts }) => {
  const messageId = "fixture-" + Math.random().toString(36).slice(2);
  const msg = { to_user_id: to, item_list: [{ type: 1, text_item: { text } }], client_id: messageId };
  if (opts?.contextToken) msg.context_token = opts.contextToken;
  const res = await fetch(opts.baseUrl + "/ilink/bot/sendmessage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ msg }) });
  if (!res.ok) throw new Error("sendmessage: " + res.status);
  return { messageId };
};`,
  ],
]) {
  const path = join(transportDir, "dist/src", file);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

const keysFile = join(dir, "keys.json");
writeFileSync(
  keysFile,
  JSON.stringify({ source: hubFns.addKey("source", "wechat"), channel: hubFns.addKey("channel", "wechat") }),
  { mode: 0o600 },
);
const accountFile = join(dir, "account.json");
writeFileSync(accountFile, JSON.stringify({ baseUrl: ilink.baseUrl, token: "fixture-token", userId: "bot" }), {
  mode: 0o600,
});
const configFile = (name: string, extra: Record<string, unknown> = {}) => {
  const file = join(dir, `${name}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      hub: base,
      me: "me@im.wechat",
      keysFile,
      rulesFile: join(import.meta.dirname, "chat.fixture.json"),
      stateFile: join(dir, `${name}.state.json`),
      accountFile,
      features: { intake: true, notify: true, answers: true },
      ...extra,
    }),
    { mode: 0o600 },
  );
  return file;
};

const run = (config: string) => {
  const child = spawnChild(
    process.execPath,
    [join(import.meta.dirname, "../adapters/wechat-clawbot/main.ts"), config],
    {
      cwd: join(import.meta.dirname, ".."),
      env: process.env,
    },
  );
  children.push(child);
  let out = "";
  child.stdout!.on("data", (chunk) => (out += chunk));
  child.stderr!.on("data", (chunk) => (out += chunk));
  const exited = new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? -1)));
  const waitFor = (pattern: RegExp, ms = 15_000) =>
    new Promise<string>((resolve, reject) => {
      const deadline = Date.now() + ms;
      const poll = () => {
        if (pattern.test(out)) return resolve(out);
        if (child.exitCode !== null) return reject(new Error(`进程已退出（${child.exitCode}），输出：${out}`));
        if (Date.now() > deadline) return reject(new Error(`等不到 ${pattern}，输出：${out}`));
        setTimeout(poll, 50);
      };
      poll();
    });
  return { child, exited, waitFor, out: () => out };
};

test("真入口：transportDir 指到传输包目录，main.ts 起得来、收发走通、SIGTERM 干净退出", async () => {
  const entry = run(configFile("entry-ok", { transportDir }));
  await entry.waitFor(/wechat-clawbot 启动/);
  // Inbound: the owner asks something — a reply must reach the fake iLink with the context_token attached.
  ilink.feed([inboundText({ message_id: "entry-1", text: "帮助" })]);
  const until = Date.now() + 15_000;
  while (!ilink.calls.sends.length && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  assert.ok(ilink.calls.sends.length >= 1, `回复没到 ilink：${entry.out()}`);
  assert.equal(ilink.calls.sends[0].msg.context_token, "ctx-secret-token");
  // Outbound: a result card the policy allows gets pushed through the same send path.
  hubFns.tell("entry-result", "结果", "上一轮归档做完了");
  const deadline = Date.now() + 15_000;
  while (
    !ilink.calls.sends.some((c) => /归档做完了/.test(c.msg.item_list[0].text_item.text)) &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(
    ilink.calls.sends.some((c) => /归档做完了/.test(c.msg.item_list[0].text_item.text)),
    `卡片没推出去：${JSON.stringify(ilink.calls.sends.map((c) => c.msg.item_list[0].text_item.text))}`,
  );
  entry.child.kill("SIGTERM");
  assert.equal(await entry.exited, 0, `没干净退出：${entry.out()}`);
  assert.ok(ilink.calls.notifyStop >= 1, "退出前没通知 ilink 停");
});

test("真入口：transportDir 目录不存在时报一句人话退出，不是裸模块报错", async () => {
  const entry = run(configFile("entry-bad", { transportDir: join(dir, "no-such-dir") }));
  const code = await entry.exited;
  assert.equal(code, 1);
  assert.match(entry.out(), /微信传输包目录.*读不了/);
});
