// Guards the WeChat ClawBot adapter end to end against a real hub (in-process serve()) and a fake iLink HTTP
// service. Failure cases it prevents: the bot's own messages or another user's messages being processed; a message
// redelivered by iLink dispatched twice; the get_updates_buf cursor living only in memory so a restart refetches
// everything; a card reported delivered when no context_token existed (the transport only warns — the hub would
// retry forever while the user saw nothing); the delivery ref not being the sent clientId so every answer fails
// the hub's ref check; a second pending card overwriting the first; an answer sent under the wrong `by`; the three
// switches not actually gating their own function.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";
import { inboundText, startFakeIlink, thinIlinkClient } from "./chat-ilink.fake.ts";

const dir = setup("chat-wechat", join(import.meta.dirname, "chat.fixture.json"));
const { serve } = await import("../host/http.ts");
const hubFns = await import("./hub.ts");
const { createWechatApp } = await import("../adapters/wechat-clawbot/app.ts");

const server = serve(0);
await new Promise((resolve) => server.once("listening", resolve));
after(() => {
  server.closeAllConnections();
  server.close();
});
const base = `http://127.0.0.1:${(server.address() as any).port}`;

const keysFile = join(dir, "wechat-keys.json");
writeFileSync(
  keysFile,
  JSON.stringify({ source: hubFns.addKey("source", "wechat"), channel: hubFns.addKey("channel", "wechat") }),
  { mode: 0o600 },
);
const configFile = (name: string, features = { intake: true, notify: true, answers: true }) => {
  const file = join(dir, name);
  writeFileSync(
    file,
    JSON.stringify({
      hub: base,
      me: "me@im.wechat",
      keysFile,
      rulesFile: join(import.meta.dirname, "chat.fixture.json"),
      stateFile: join(dir, `${name}.state.json`),
      features,
    }),
    { mode: 0o600 },
  );
  return file;
};

test("收指令：只认本人，回执走 context_token，游标持久化，重投不重复派单", async () => {
  const ilink = await startFakeIlink();
  const app = await createWechatApp({ configFile: configFile("wx1.json"), io: thinIlinkClient(ilink.baseUrl) });
  ilink.feed([
    inboundText({ message_id: "w-bot", message_type: 2, text: "机器人自己的话" }),
    inboundText({ message_id: "w-other", from_user_id: "someone-else", text: "状态" }),
    inboundText({ message_id: "w-1", text: "ai-loop：今天做了啥" }),
  ]);
  await app.pollOnce();

  const sends = ilink.calls.sends.map((call) => call.msg);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].context_token, "ctx-secret-token");
  assert.match(sends[0].item_list[0].text_item.text, /已派给「微信 AI Loop 任务」/);

  // The platform redelivers the same message_id: no second dispatch, no second reply.
  ilink.feed([inboundText({ message_id: "w-1", text: "ai-loop：今天做了啥" })]);
  await app.pollOnce();
  assert.equal(ilink.calls.sends.length, 1);

  // Restart with the same state file: the persisted cursor goes back to iLink, old messages aren't refetched.
  await app.stop();
  const again = await createWechatApp({ configFile: configFile("wx1.json"), io: thinIlinkClient(ilink.baseUrl) });
  ilink.feed([inboundText({ message_id: "w-2", text: "项目" })]);
  await again.pollOnce();
  assert.notEqual(ilink.calls.updates.at(-1), "buf-0");
  assert.match(ilink.calls.sends.at(-1)!.msg.item_list[0].text_item.text, /ai-loop/);
  await again.stop();
  ilink.close();
});

test("发通知：没有 context_token 时卡片报 failed，不假装送达", async () => {
  const ilink = await startFakeIlink();
  const app = await createWechatApp({ configFile: configFile("wx2.json"), io: thinIlinkClient(ilink.baseUrl) });
  const { card } = hubFns.createCard({ key: "n1", kind: "notice", title: "巡检完了", text: "都正常" });
  assert.equal(await app.deliverOnce(0), true);
  assert.equal(ilink.calls.sends.length, 0);
  // Honestly reported failed, not delivered: no ref recorded, the error is there, and the hub will offer it again.
  const delivery = hubFns.getView().get("deliveries", `${card}:wechat`)!;
  assert.equal(delivery.ref, null);
  assert.match(delivery.error, /context_token/);
  await app.stop();
  ilink.close();
});

test("发通知+拍板：送达报告 clientId 为 ref，# 号回答带对 by/ref，多卡不串", async () => {
  const ilink = await startFakeIlink();
  const app = await createWechatApp({ configFile: configFile("wx3.json"), io: thinIlinkClient(ilink.baseUrl) });
  // One incoming message first: its context_token is the only reply credential.
  ilink.feed([inboundText({ message_id: "w-hello", text: "帮助" })]);
  await app.pollOnce();

  const a = hubFns.createCard({ key: "a1", kind: "ask", title: "删缓存吗", options: ["删", "留着"], recommend: 0 });
  const b = hubFns.createCard({ key: "a2", kind: "ask", title: "发布吗", options: ["发", "等会"], recommend: 1 });
  await app.deliverOnce(0);
  await app.deliverOnce(0);
  const texts = ilink.calls.sends.map((call) => call.msg.item_list[0].text_item.text);
  assert.match(texts.at(-2)!, new RegExp(`#${a.card}`));
  assert.match(texts.at(-1)!, new RegExp(`#${b.card}`));
  const refA = ilink.calls.sends.at(-2)!.msg.client_id;
  const refB = ilink.calls.sends.at(-1)!.msg.client_id;

  // A bare number with two open cards is an answer attempt that needs the card number.
  ilink.feed([inboundText({ message_id: "w-n", text: "1" })]);
  await app.pollOnce();
  assert.match(ilink.calls.sends.at(-1)!.msg.item_list[0].text_item.text, /#.*写卡片号|写「#/);

  ilink.feed([inboundText({ message_id: "w-a", text: `#${a.card} 2` })]);
  await app.pollOnce();
  const card = hubFns.getView().get("cards", a.card)!;
  assert.equal(card.state, "decided");
  assert.equal(card.choice, 1);
  assert.equal(card.answer, null);
  assert.equal(card.by, "me@im.wechat");
  // The ref that reached the hub is the clientId of that card's delivery.
  assert.equal(hubFns.getView().get("deliveries", `${a.card}:wechat`)!.ref, refA);
  assert.equal(hubFns.getView().get("deliveries", `${b.card}:wechat`)!.ref, refB);

  // Deciding the same card again: the hub says so and the adapter passes it on, not a crash.
  ilink.feed([inboundText({ message_id: "w-a2", text: `#${a.card} 1` })]);
  await app.pollOnce();
  assert.match(ilink.calls.sends.at(-1)!.msg.item_list[0].text_item.text, /已经定过|定好了/);
  await app.stop();
  ilink.close();
});

test("拍定的卡不占待拍板：唯一 open 卡可省号，定过的卡给诚实回答", async () => {
  const ilink = await startFakeIlink();
  const app = await createWechatApp({ configFile: configFile("wx5.json"), io: thinIlinkClient(ilink.baseUrl) });
  try {
    ilink.feed([inboundText({ message_id: "w5-hello", text: "帮助" })]);
    await app.pollOnce();
    const texts = () => ilink.calls.sends.map((call) => call.msg.item_list[0].text_item.text as string);
    // Drain leftovers from earlier tests first (the hub re-offers decided cards), so each offer below is the new card.
    const drain = async () => {
      while (await app.deliverOnce(0)) {}
    };

    const a = hubFns.createCard({ key: "w5-a", kind: "ask", title: "删缓存吗", options: ["删", "留着"], recommend: 0 });
    await drain();
    assert.ok(
      texts().some((text) => text.includes(`#${a.card}`)),
      "卡 A 得发到微信",
    );
    ilink.feed([inboundText({ message_id: "w5-a1", text: `#${a.card} 1` })]);
    await app.pollOnce();
    assert.equal(hubFns.getView().get("cards", a.card)!.state, "decided");

    // 索引还没清掉前重复拍同一张：中枢说「已经定过了」，原样转达。
    ilink.feed([inboundText({ message_id: "w5-a2", text: `#${a.card} 1` })]);
    await app.pollOnce();
    assert.match(texts().at(-1)!, /已经定过/);

    const b = hubFns.createCard({ key: "w5-b", kind: "ask", title: "发布吗", options: ["发", "等会"], recommend: 0 });
    // 中枢把已定卡的更新版再 offer 一遍（delivery.ref 非空值得发）：政策压下，顺手把索引里的它忘掉。
    await drain();
    assert.deepEqual(
      app.pending().map((c) => c.id),
      [b.card],
      "待拍板只剩真正开着的卡",
    );

    // 「等你拍板」附言只数开着的：#A 不再出现。
    ilink.feed([inboundText({ message_id: "w5-proj", text: "项目" })]);
    await app.pollOnce();
    const suffix = texts().find((text) => /另外有.*等你拍板/.test(text));
    assert.ok(suffix?.includes(`#${b.card}`), `附言该提 #${b.card}：${suffix}`);
    assert.ok(!suffix?.includes(`#${a.card}`), `附言不该提已定的 #${a.card}：${suffix}`);

    // 唯一开着的卡：裸「1」直接拍它，不再被要求写卡片号。
    ilink.feed([inboundText({ message_id: "w5-b1", text: "1" })]);
    await app.pollOnce();
    const decidedB = hubFns.getView().get("cards", b.card)!;
    assert.equal(decidedB.state, "decided");
    assert.equal(decidedB.choice, 0);

    // 已决版重投被消化后，#A 得到的是「没有待拍板的卡片」。
    ilink.feed([inboundText({ message_id: "w5-a3", text: `#${a.card} 1` })]);
    await app.pollOnce();
    assert.match(texts().at(-1)!, /没有待拍板的卡片/);
  } finally {
    await app.stop();
    ilink.close();
  }
});

test("并发重投：两个批次同时处理同一条 message_id，只派一次", async () => {
  const ilink = await startFakeIlink();
  const app = await createWechatApp({ configFile: configFile("wx4.json"), io: thinIlinkClient(ilink.baseUrl) });
  const dup = inboundText({ message_id: "w-dup", text: "帮助" });
  ilink.feed([dup, dup]);
  const io2 = thinIlinkClient(ilink.baseUrl);
  const second = await createWechatApp({ configFile: configFile("wx4.json"), io: io2 });
  // Genuinely concurrent: two adapter runs over the same state file and hub.
  await Promise.all([app.pollOnce(), second.pollOnce(), app.pollOnce()]);
  const helps = ilink.calls.sends.filter((call) => /帮助|指令/.test(call.msg.item_list[0].text_item.text));
  assert.equal(helps.length, 1);
  await app.stop();
  await second.stop();
  ilink.close();
});

test("三个开关各自只关自己的功能", async () => {
  const ilink = await startFakeIlink();
  const intakeOff = await createWechatApp({
    configFile: configFile("wx-off-intake.json", { intake: false, notify: true, answers: true }),
    io: thinIlinkClient(ilink.baseUrl),
  });
  ilink.feed([inboundText({ message_id: "sw1", text: "帮助" })]);
  await intakeOff.pollOnce();
  assert.equal(ilink.calls.sends.length, 0);
  await intakeOff.stop();

  const notifyOff = await createWechatApp({
    configFile: configFile("wx-off-notify.json", { intake: true, notify: false, answers: true }),
    io: thinIlinkClient(ilink.baseUrl),
  });
  hubFns.createCard({ key: "sw-card", kind: "notice", title: "不该出去", text: "x" });
  assert.equal(await notifyOff.deliverOnce(0), false);
  assert.equal(ilink.calls.sends.length, 0);
  await notifyOff.stop();

  const answersOff = await createWechatApp({
    configFile: configFile("wx-off-answers.json", { intake: true, notify: true, answers: false }),
    io: thinIlinkClient(ilink.baseUrl),
  });
  ilink.feed([inboundText({ message_id: "sw2", text: `#1 1` })]);
  await answersOff.pollOnce();
  assert.match(ilink.calls.sends.at(-1)!.msg.item_list[0].text_item.text, /拍板.*关|没开/);
  await answersOff.stop();
  ilink.close();
});
