// AI Loop × 微信主动推送探测：拿持久化的回复凭据（context_token）发一条测试消息，然后盯 getUpdates
// 看平台有没有把这条消息放回会话流——不拿到手机的情况下，这是唯一能自动拿到的接收端信号。
// 发送接口返回成功不等于送达；回执看不到自己的消息就判「未送达/不确定」。
//
// 用法：
//   node adapters/testing/wechat-probe.mjs --account <account.json> --context <context.json> \
//     --transport <transport/package 目录> --text "AI Loop 测试 …" [--peek 20]
//
// account.json = { token, userId, baseUrl }；context.json = { contextToken, at }。
// 输出：凭据年龄、发送接口结果、回执判定。凭据和帐号内容一个字都不打印。
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

// 回执段不能静默死：任何没接住的异常都先落日志再退，证据不能丢。
process.on("unhandledRejection", (e) => console.log(`未捕获的拒绝：${String(e?.stack ?? e).slice(0, 300)}`));
process.on("uncaughtException", (e) => {
  console.log(`未捕获的异常：${String(e?.stack ?? e).slice(0, 300)}`);
  process.exit(4);
});

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? dflt : process.argv[i + 1];
};

const accountFile = arg("account");
const contextFile = arg("context");
const transport = arg("transport");
const text = arg("text", "AI Loop 测试");
const peekSeconds = Number(arg("peek", "20"));

if (!accountFile || !contextFile || !transport || !text.includes("AI Loop 测试")) {
  console.error("用法：--account <帐号.json> --context <凭据.json> --transport <包目录> --text <带「AI Loop 测试」的内容>");
  process.exit(64);
}

const account = JSON.parse(readFileSync(accountFile, "utf8"));
const context = JSON.parse(readFileSync(contextFile, "utf8"));
const { baseUrl, token, userId } = account;
const { contextToken, at } = context;

const api = await import(`${transport}/dist/src/api/api.js`);
const { sendMessageWeixin } = await import(`${transport}/dist/src/messaging/send.js`);

const ageHours = at ? (Date.now() - Date.parse(at)) / 3_600_000 : null;
console.log(`凭据采于 ${at ?? "未知时间"}（约 ${ageHours === null ? "?" : ageHours.toFixed(1)} 小时前）`);
if (!contextToken) {
  console.log("没有回复凭据，发不出去");
  process.exit(1);
}

// 先取一次当前流位置：后面回执只看这次发送之后进来的东西。
let buf = "";
try {
  const pos = await api.getUpdates({ baseUrl, token, get_updates_buf: "", timeoutMs: 8_000 });
  buf = pos.get_updates_buf ?? "";
  console.log(`取到当前游标（积压 ${pos.msgs?.length ?? 0} 条）`);
} catch (error) {
  console.log(`取游标失败：${String(error.message ?? error).slice(0, 120)}（按无回执继续）`);
}

let messageId = null;
try {
  const sent = await sendMessageWeixin({
    to: userId,
    text,
    opts: { baseUrl, token, contextToken, timeoutMs: 12_000 },
  });
  messageId = sent?.messageId ?? null;
  console.log(`发送接口返回：成功（${messageId ? "有消息号" : "无消息号"}）`);
} catch (error) {
  console.log(`发送接口返回：失败 —— ${String(error.message ?? error).slice(0, 200)}`);
  process.exit(2);
}

// 接收端判定：自己的 bot 消息会不会回到会话流里（message_type===2，或任何带同样文字的消息）。
const mark = text.slice(0, 24);
const deadline = Date.now() + peekSeconds * 1_000;
let echo = false;
let otherMsgs = 0;
while (Date.now() < deadline && !echo) {
  try {
    const data = await api.getUpdates({ baseUrl, token, get_updates_buf: buf, timeoutMs: 8_000 });
    buf = data.get_updates_buf ?? buf;
    for (const m of data.msgs ?? []) {
      const words = (m.item_list ?? []).map((i) => i.text_item?.text ?? "").join("\n");
      if (words.includes(mark)) echo = true;
      else otherMsgs += 1;
    }
  } catch (error) {
    console.log(`盯回执时出错：${String(error.message ?? error).slice(0, 120)}`);
  }
  if (!echo) await delay(1_500);
}
if (echo) {
  console.log("回执判定：平台把这条消息落进了会话流——接收端可见");
  process.exit(0);
}
console.log(`回执判定：${peekSeconds} 秒内没看到自己的消息回到会话流（期间流过其它消息 ${otherMsgs} 条）——判未送达或不确定`);
process.exit(3);
