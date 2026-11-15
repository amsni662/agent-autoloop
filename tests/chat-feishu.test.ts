// Guards the Feishu chat adapter end to end against a real hub (in-process serve()) and a fake lark-cli process.
// Failure cases it prevents: a message from anyone but the configured owner processed; a group-chat or non-text
// or bot-typed message dispatched; the delivery id (event_id) used for dedup instead of the stable message_id so
// a redelivered event dispatches twice; a "#<号>" answer attempted on a channel that can't map numbers to card
// messages; a quoted reply not carrying the card's om_ ref so the hub rejects it; NDJSON split mid-record
// corrupting events; the intake switch still starting consume when it's off.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";

const dir = setup("chat-feishu", join(import.meta.dirname, "chat.fixture.json"));
const { serve } = await import("../host/http.ts");
const hubFns = await import("./hub.ts");
const { createFeishuApp } = await import("../adapters/feishu-chat/app.ts");

const server = serve(0);
await new Promise((resolve) => server.once("listening", resolve));
after(() => {
  server.closeAllConnections();
  server.close();
});
const base = `http://127.0.0.1:${(server.address() as any).port}`;

const keysFile = join(dir, "feishu-keys.json");
writeFileSync(
  keysFile,
  JSON.stringify({ source: hubFns.addKey("source", "feishu"), channel: hubFns.addKey("channel", "feishu") }),
  { mode: 0o600 },
);
const LARK = join(import.meta.dirname, "chat-lark.fake.mjs");
const ME = "ou_me";

const imEvent = (over: Record<string, unknown>) => ({
  event_id: `evt-${Math.random().toString(36).slice(2)}`,
  message_id: "om_1",
  sender_id: ME,
  sender_type: "user",
  chat_id: "oc_p2p",
  chat_type: "p2p",
  message_type: "text",
  content: "状态",
  ...over,
});

const startApp = async (name: string, events: object[], extra: Record<string, unknown> = {}) => {
  const log = join(dir, `${name}.lark.log`);
  const configFile = join(dir, `${name}.json`);
  writeFileSync(
    configFile,
    JSON.stringify({
      hub: base,
      me: ME,
      keysFile,
      rulesFile: join(import.meta.dirname, "chat.fixture.json"),
      stateFile: join(dir, `${name}.state.json`),
      features: { intake: true, notify: true, answers: true },
      ...extra,
    }),
    { mode: 0o600 },
  );
  const app = await createFeishuApp({
    configFile,
    lark: LARK,
    restartMs: 60_000,
    env: {
      LARK_EVENTS: events.map((e) => JSON.stringify(e)).join("\n"),
      LARK_EXIT_AFTER: "1",
      LARK_LOG: log,
      PATH: process.env.PATH!,
    },
  });
  const sent = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  return { app, log, sent };
};

test("收指令：只认本人 p2p 文本；重投按 message_id 去重；回复走 +messages-send", async () => {
  const { app, sent } = await startApp("fs1", [
    imEvent({ message_id: "om_a1", sender_id: "ou_someone_else", content: "状态" }),
    imEvent({ message_id: "om_a2", chat_type: "group", content: "状态" }),
    imEvent({ message_id: "om_a3", message_type: "image", content: "{}" }),
    imEvent({ message_id: "om_a4", sender_type: "bot", content: "状态" }),
    imEvent({ message_id: "om_a5", content: "盘点 mini" }),
    imEvent({ message_id: "om_a5", event_id: "evt-redelivered", content: "盘点 mini" }),
  ]);
  await app.drain();
  const replies = sent();
  assert.equal(replies.length, 1);
  const argv = replies[0];
  assert.ok(argv.includes("+messages-send"));
  assert.ok(argv.includes(ME));
  assert.match(argv[argv.length - 1], /已派给「飞书盘点 Mini」/);
  await app.stop();
});

test("引用回复拍板：#卡片号 + reply_to 两把都齐才交回答", async () => {
  // The hub's own feishu channel delivered this card as om_card1; the chat adapter must not claim cards itself.
  const { card } = hubFns.createCard({
    key: "f1",
    kind: "ask",
    title: "发布吗",
    options: ["发", "等会"],
    recommend: 0,
  });
  hubFns.delivered("feishu", card, 1, "om_card1");
  const { app, sent } = await startApp("fs2", [
    // Quote reply carrying the card number: id from the text, ref from reply_to — the answer goes through.
    imEvent({ message_id: "om_q1", content: `#${card} 2`, reply_to: "om_card1" }),
    imEvent({ message_id: "om_q2", content: `#${card} 1`, reply_to: "om_card1" }),
    // A quoted reply without the card number can't be mapped — hint, never guess.
    imEvent({ message_id: "om_q3", content: "2", reply_to: "om_card1" }),
    imEvent({ message_id: "om_q4", content: "随便写点什么", reply_to: "om_not_a_card" }),
  ]);
  await app.drain();
  const decided = hubFns.getView().get("cards", card)!;
  assert.equal(decided.state, "decided");
  assert.equal(decided.choice, 1);
  assert.equal(decided.by, ME);
  const replies = sent().map((argv) => argv.at(-1) as string);
  assert.ok(replies.some((text) => /已经定过|定好了/.test(text)));
  assert.ok(replies.filter((text) => /卡片号|按钮/.test(text)).length >= 2);
  await app.stop();
});

test("# 写法在飞书：回提示不猜；收指令开关关掉就不动", async () => {
  const { app, sent } = await startApp("fs3", [imEvent({ message_id: "om_h1", content: "#5 1" })]);
  await app.drain();
  assert.match(sent()[0].at(-1)!, /引用回复/);
  await app.stop();

  const quiet = await startApp("fs4", [imEvent({ message_id: "om_h2", content: "状态" })], {
    features: { intake: false, notify: true, answers: true },
  });
  await quiet.app.drain();
  assert.deepEqual(quiet.sent(), []);
  await quiet.app.stop();
});

test("入口重启：同一条 message_id 不再派第二次", async () => {
  const first = await startApp("fs6", [imEvent({ message_id: "om_same", content: "帮助" })]);
  await first.app.drain();
  await first.app.stop();
  const second = await startApp("fs6b", [imEvent({ message_id: "om_same", content: "帮助" })], {
    stateFile: join(dir, "fs6.state.json"),
  });
  await second.app.drain();
  await second.app.stop();
  assert.equal(first.sent().length + second.sent().length, 1);
});

test("consume 退出后按间隔重启，stdin 不被适配器关闭", async () => {
  const { app } = await startApp("fs5", [imEvent({ message_id: "om_r1", content: "帮助" })], {});
  await app.drain();
  assert.equal(app.restarts(), 1);
  await app.stop();
});
