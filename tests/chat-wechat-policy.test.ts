// Guards the WeChat ClawBot adapter's outbound policy end to end. Failure cases it prevents: a card the message
// list doesn't allow being pushed to WeChat instead of acknowledged-and-logged; a suppressed card leaving no
// audit trail; the same card text pushed twice when the hub re-offers it after a lost delivery report or a
// restart; a stale context_token sending a message the platform accepts but never delivers (the API-OK-
// no-arrival bug) instead of an honest failed; internal codenames/paths/JSON in card text or replies reaching
// the owner; a pending decision not being mentioned when the owner chats; the credential's capture time not
// being persisted; a settled card's update being pushed as a new message.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { setup } from "./helpers.ts";
import { inboundText, startFakeIlink, thinIlinkClient } from "./chat-ilink.fake.ts";

const dir = setup("chat-wechat-policy", join(import.meta.dirname, "chat.fixture.json"));
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
const configFile = (name: string, extra: Record<string, unknown> = {}) => {
  const file = join(dir, name);
  writeFileSync(
    file,
    JSON.stringify({
      hub: base,
      me: "me@im.wechat",
      keysFile,
      rulesFile: join(import.meta.dirname, "chat.fixture.json"),
      stateFile: join(dir, `${name}.state.json`),
      features: { intake: true, notify: true, answers: true },
      ...extra,
    }),
    { mode: 0o600 },
  );
  return file;
};

// Failing mid-test must not leak a polling app or an open fake server — everything spawned here is closed in
// afterEach so a failed assertion doesn't hang the file.
const spawned: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of spawned.splice(0)) await close();
});
const spawn = async (name: string, extra: Record<string, unknown> = {}) => {
  const ilink = await startFakeIlink();
  const app = await createWechatApp({ configFile: configFile(name, extra), io: thinIlinkClient(ilink.baseUrl) });
  spawned.push(
    () => ilink.close(),
    () => app.stop(),
  );
  return { ilink, app };
};

const texts = (ilink: Awaited<ReturnType<typeof startFakeIlink>>) =>
  ilink.calls.sends.map((call) => call.msg.item_list[0].text_item.text as string);

// The hub and its cards are shared across this file's tests: whatever an earlier test left undelivered gets
// claimed first — drain it so each test only sees its own cards.
const drain = async (app: Awaited<ReturnType<typeof createWechatApp>>) => {
  while (await app.deliverOnce(0)) {}
};

const greet = async (
  ilink: Awaited<ReturnType<typeof startFakeIlink>>,
  app: Awaited<ReturnType<typeof createWechatApp>>,
  tag: string,
) => {
  ilink.feed([inboundText({ message_id: `${tag}-hello`, text: "帮助" })]);
  await app.pollOnce();
};

test("政策压下的卡：不发出，记状态可查，版本算已投递", async () => {
  const { ilink, app } = await spawn("wp1.json");
  await greet(ilink, app, "wp1");
  await drain(app);
  const before = ilink.calls.sends.length;

  const { card } = hubFns.createCard({
    key: "t1",
    kind: "notice",
    title: "微信 AI Loop 任务",
    text: "连续 3 次自动处理没跑完（卡在：限流），21:01 会自动再试。",
    state: "open",
  });
  assert.equal(await app.deliverOnce(0), true);
  assert.equal(ilink.calls.sends.length, before, "被政策压下的卡一条文字都不发");
  // 中枢不再反复 offer 它（版本已记投递，ref 为空说明没发文字），本地留痕说清为什么没发。
  const delivery = hubFns.getView().get("deliveries", `${card}:wechat`)!;
  assert.equal(delivery.version, 1);
  assert.equal(delivery.ref, null);
  assert.match(app.state.suppressed!.at(-1)!.what, new RegExp(`card:${card}:`));
  assert.ok(app.state.suppressed!.at(-1)!.why.length > 0, "压下要给个理由");
});

test("拍板卡发出去：文本过净身，ref=clientId，同版本重投不再发第二遍", async () => {
  const { ilink, app } = await spawn("wp2.json");
  await greet(ilink, app, "wp2");
  await drain(app);
  const before = ilink.calls.sends.length;

  const { card } = hubFns.createCard({
    key: "t2",
    kind: "ask",
    title: "「试一下 MBP」要本人处理",
    text: "要本人处理：鉴权失效\n设备 mbp · Agent Claude Code · 分类：auth_invalid\n日志在 /Users/spider/x/y.log",
    options: ["已恢复，重新派一轮", "先不做了"],
    recommend: 0,
  });
  await app.deliverOnce(0);
  const sent = texts(ilink);
  assert.equal(sent.length, before + 1);
  const body = sent.at(-1)!;
  assert.match(body, /要本人处理/);
  assert.match(body, /回复 #\d+/);
  for (const bad of ["auth_invalid", "/Users/spider"]) assert.ok(!body.includes(bad), `不该出现「${bad}」`);
  const ref = ilink.calls.sends.at(-1)!.msg.client_id;
  assert.equal(hubFns.getView().get("deliveries", `${card}:wechat`)!.ref, ref);

  // 中枢把同一版本再 offer 一遍（投递回报丢了、重启后重投）：不再发第二遍文字，把上次的 ref 补报回去。
  // fixtureClear 清的是全部投递行，前面别的卡也会被重新 offer——drain 到轮到这张卡。
  hubFns.fixtureClear("deliveries");
  await drain(app);
  assert.equal(ilink.calls.sends.length, before + 1, "同一版本不重发");
  assert.equal(hubFns.getView().get("deliveries", `${card}:wechat`)!.ref, ref, "丢过的投递回报用已存的 ref 补回来");
});

test("回复文本也过净身：本人带回的回答里的路径不原样弹回", async () => {
  const { ilink, app } = await spawn("wp3.json");
  await greet(ilink, app, "wp3");
  await drain(app);
  const { card } = hubFns.createCard({ key: "t3", kind: "ask", title: "发布吗", options: ["发", "等会"] });
  await app.deliverOnce(0);
  ilink.feed([inboundText({ message_id: "wp3-a", text: `#${card} /Users/spider/secret 这个目录可以吗` })]);
  await app.pollOnce();
  const reply = texts(ilink).at(-1)!;
  assert.match(reply, /已记下/);
  assert.ok(!reply.includes("/Users/"), `路径不该弹回：${reply}`);
});

test("有待拍板时闲聊顺带提一句，答完不提", async () => {
  const { ilink, app } = await spawn("wp4.json");
  await greet(ilink, app, "wp4");
  await drain(app);
  const { card } = hubFns.createCard({ key: "t4", kind: "ask", title: "发布吗", options: ["发", "等会"] });
  await app.deliverOnce(0);
  const n = ilink.calls.sends.length;

  ilink.feed([inboundText({ message_id: "wp4-q", text: "项目" })]);
  await app.pollOnce();
  const recent = texts(ilink).slice(n);
  assert.ok(
    recent.some((text) => new RegExp(`等你拍板.*#${card}`).test(text)),
    `该顺带提拍板：${recent}`,
  );

  ilink.feed([inboundText({ message_id: "wp4-ans", text: `#${card} 1` })]);
  await app.pollOnce();
  // 处理中的那条回答路径不再加「等你拍板」尾巴
  assert.ok(!/等你拍板/.test(texts(ilink).at(-1)!));
});

test("凭据保鲜：采集时间写进状态；过期的凭据不硬发，报 failed", async () => {
  const { ilink, app } = await spawn("wp5.json", { policy: { tokenMaxAgeMs: 3_600_000 } });
  await greet(ilink, app, "wp5");
  assert.ok(app.state.contextTokenAt, "采集时间要落盘");
  assert.ok(Date.now() - Date.parse(app.state.contextTokenAt!) < 60_000);

  // 把采集时间改成两小时前：超过 tokenMaxAgeMs 的凭据不发了，卡片报 failed 留在中枢。
  app.state.contextTokenAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
  await drain(app);
  const { card } = hubFns.createCard({ key: "t5", kind: "ask", title: "发布吗", options: ["发", "等会"] });
  const before = ilink.calls.sends.length;
  assert.equal(await app.deliverOnce(0), true);
  assert.equal(ilink.calls.sends.length, before, "过期凭据不硬发");
  const delivery = hubFns.getView().get("deliveries", `${card}:wechat`)!;
  assert.equal(delivery.ref, null);
  assert.match(delivery.error, /凭据|小时|送达/);

  // 凭据刷新回来（新来信带来新 token）又能发了。
  ilink.feed([inboundText({ message_id: "wp5-refresh", text: "帮助", context_token: "ctx-fresh-token" })]);
  await app.pollOnce();
  assert.ok(Date.now() - Date.parse(app.state.contextTokenAt!) < 60_000, "新来信把采集时间刷回来");
});

test("凭据保鲜默认 15 分钟：不写 tokenMaxAgeMs 也限龄", async () => {
  const { ilink, app } = await spawn("wp5b.json");
  await greet(ilink, app, "wp5b");
  await drain(app);
  // 配置没写保鲜期：按内置 15 分钟闸，20 分钟前的凭据不硬发，卡片照实报 failed。
  app.state.contextTokenAt = new Date(Date.now() - 20 * 60_000).toISOString();
  const { card } = hubFns.createCard({ key: "t5b", kind: "ask", title: "发布吗", options: ["发", "等会"] });
  const before = ilink.calls.sends.length;
  assert.equal(await app.deliverOnce(0), true);
  assert.equal(ilink.calls.sends.length, before, "超过默认保鲜期的凭据不硬发");
  assert.match(hubFns.getView().get("deliveries", `${card}:wechat`)!.error!, /凭据|送达/);
});

test("定了的卡更新不推：decided 版本再 offer 也只记投递", async () => {
  const { ilink, app } = await spawn("wp6.json");
  await greet(ilink, app, "wp6");
  await drain(app);
  const { card } = hubFns.createCard({ key: "t6", kind: "ask", title: "发布吗", options: ["发", "等会"] });
  await app.deliverOnce(0);
  const before = ilink.calls.sends.length;
  // 本人在别处定了它：卡片结案，中枢把更新版再 offer 给微信——不发第二条文字。
  hubFns.resolve(card, "在别处定了", "ou_me");
  assert.equal(await app.deliverOnce(0), true);
  assert.equal(ilink.calls.sends.length, before, "定了的卡不推第二条");
});

test("凭据盖章：平台复用同一 token 的新来信也刷新时间，旧消息重投不显嫩", async () => {
  const { ilink, app } = await spawn("wp7.json");
  await greet(ilink, app, "wp7");
  // 平台连续两条消息用同一个 token：第二条（新 message_id）照样把采集时间刷新。
  app.state.contextTokenAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
  ilink.feed([inboundText({ message_id: "wp7-same-token", text: "状态", context_token: "ctx-secret-token" })]);
  await app.pollOnce();
  assert.ok(Date.now() - Date.parse(app.state.contextTokenAt!) < 60_000, "同 token 的新来信也要刷新时间");
  // 反过来：同一条旧消息被平台重投，不许把旧凭据盖成新的。
  app.state.contextTokenAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const old = app.state.contextTokenAt;
  ilink.feed([inboundText({ message_id: "wp7-same-token", text: "状态", context_token: "ctx-secret-token" })]);
  await app.pollOnce();
  assert.equal(app.state.contextTokenAt, old, "重投的旧消息不许刷新凭据时间");
});

test("回复连续被凭据闸拦下：向中枢上报一张本人能看到的卡", async () => {
  const { ilink, app } = await spawn("wp8.json");
  await greet(ilink, app, "wp8");
  // 凭据还在但已过期：每条回复都被拦；拦到第 3 条时，往中枢 tell 一张「微信回不出去」的卡。
  app.state.contextTokenAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
  for (const id of ["wp8-a", "wp8-b", "wp8-c"]) {
    ilink.feed([inboundText({ message_id: id, text: "帮助", context_token: undefined })]);
    await app.pollOnce();
  }
  const day = new Date().toISOString().slice(0, 10);
  const key = `source:wechat:wechat-reply-blocked-${day}`;
  const { rows } = await import("../kernel/evolve.ts");
  const find = () => rows(hubFns.getView(), "cards", { key })[0];
  const deadline = Date.now() + 3_000; // 上报是异步的，等它落库
  while (!find() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  const card = find();
  assert.ok(card, "连续被拦没有上报给中枢");
  assert.match(card!.text!, /回复凭据|发一句话/);
});
