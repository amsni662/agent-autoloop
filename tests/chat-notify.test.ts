// Guards the owner-message policy in adapters/chat/notify.ts (docs/消息清单.md). Failure cases it prevents:
// internal codenames (S/T numbers, round numbers, run:/event: keys, hub=commit strings, source/channel ids,
// English category names) reaching the owner's phone; absolute paths, stack frames, JSON payloads and raw error
// text leaking through card text or error replies; a card type the table doesn't name being pushed instead of
// staying dashboard-only; an ask card or a needs-action notice being silenced; self-healing noise (retries,
// no-reply, archive errors, build progress, short offline) arriving on the phone; the offline escalation not
// firing at the 2-hour mark; a whole-category switch not silencing its class; overlong text arriving untruncated;
// the decided-update of a card the owner already settled arriving as a second message.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classify,
  DEFAULT_POLICY,
  loadPolicy,
  renderOwnerCard,
  sanitize,
  type CardLike,
} from "../adapters/chat/notify.ts";

const card = (over: Partial<CardLike> = {}): CardLike => ({
  id: 1,
  kind: "notice",
  state: "open",
  title: "标题",
  ...over,
});

test("sanitize：hub=commit、长串、路径、堆栈、JSON、英文分类、内部代号都不出门", () => {
  const dirty = [
    "中枢运行正常（hub=48181f8e3ee29daf2577aef0fe5ae61d4eb85948）",
    "写在 /Users/spider/mini-hub/ai-loop/status/S15.md 里",
    "    at decide (kernel/decide.ts:1122:9)",
    'API Error: 403 {"error":{"type":"forbidden","msg":"no"}}',
    "分类：transient_error · 第 3 轮 run:42 · 来源 wechat:wx-123",
    "AI Loop 进度：已开始 S9，T14 验收",
  ].join("\n");
  const out = sanitize(dirty);
  for (const bad of [
    "48181f8",
    "/Users/",
    "at decide",
    '"error"',
    "forbidden",
    "transient_error",
    "S9",
    "T14",
    "第 3 轮",
    "run:42",
    "wechat:wx-123",
    "403",
  ]) {
    assert.ok(!out.includes(bad), `不该出现「${bad}」，实得：${out}`);
  }
  assert.match(out, /中枢运行正常/);
  assert.match(out, /AI Loop 进度：已开始/);
});

test("sanitize：超长截断到上限并注明「详情见看板」", () => {
  const out = sanitize("很长的一句话。".repeat(80));
  assert.ok(out.length <= 560, `截断后 ${out.length} 字`);
  assert.match(out, /详情见看板/);
  const manyLines = Array.from({ length: 12 }, (_, i) => `第${i + 1}行内容`).join("\n");
  const clipped = sanitize(manyLines);
  assert.match(clipped, /详情见看板/);
  assert.ok(!clipped.includes("第12行内容"));
});

test("classify：要拍板/动手的全放行——提问卡、等处理通知、停下、写错、刹车、链不可用", () => {
  const decide = [
    card({ kind: "ask", title: "删缓存吗", options: ["删", "留着"] }),
    card({ kind: "ask", title: "「试一下 MBP」要本人处理", text: "要本人处理：登录失效" }),
    card({ kind: "ask", title: "要确认：「微信 AI Loop 任务」的指令" }),
    card({ title: "事件循环已停止", text: "同一条处理链已超过 8 层", state: "open" }),
    card({ title: "rules.json 写错了，还在用旧规则", text: "第 3 条规则缺了交给谁", state: "open" }),
    card({ title: "catalog 清单有问题，还在用旧清单", text: "型号对不上", state: "open" }),
    card({ title: "试一下 MBP", text: "连续 10 次自动处理没跑完（卡在：登录失效），不再自动重试", state: "open" }),
    card({ title: "微信 AI Loop 任务", text: "「微信 AI Loop 任务」现在没有能用的候选（限流）", state: "open" }),
    card({ title: "Agent 的提醒", text: "这个目录权限不够，要我改吗", state: "open" }),
  ];
  for (const c of decide) {
    const verdict = classify(c);
    if (!verdict.send) assert.fail(`该发没发：${c.title}`);
    assert.equal(verdict.category, "decide", `${c.title} 该算拍板类`);
  }
});

test("classify：本人说过要知道的结果——做成结果、告警、Agent 汇报、别处托付", () => {
  const results = [
    card({ title: "微信 AI Loop 任务", text: "版本核对完了，没差", state: "closed" }),
    card({ title: "AI Loop 备份失败", text: "昨晚的备份没传到云端", state: "closed" }),
    card({ title: "AI Loop 告警", text: "Mini 磁盘只剩 12%", state: "closed" }),
    card({ title: "Agent 汇报", text: "顺手发现一个问题", state: "closed" }),
  ];
  for (const c of results) {
    const verdict = classify(c);
    if (!verdict.send) assert.fail(`该发没发：${c.title}`);
    assert.equal(verdict.category, "result", `${c.title} 该算结果类`);
  }
});

test("classify：自动恢复的、进度类、已定的，只记状态不推", () => {
  const hush = [
    card({ title: "微信任务", text: "交给 Mini 开发 后超过 5 分钟没有回音，不确定做没做完", state: "open" }),
    card({ title: "微信任务", text: "连续 3 次自动处理没跑完（卡在：限流），21:01 会自动再试。", state: "open" }),
    card({ title: "微信任务", text: "这一轮的档案写回没写进去：磁盘满了", state: "open" }),
    card({ title: "AI Loop 进度", text: "已开始搭建", state: "closed" }),
    card({ title: "接单程序没连上", text: "mbp 已经 47 分钟没连上中台，有 1 件任务在排队", state: "open" }),
    card({ title: "删缓存吗", state: "decided", choice: 0 }),
    card({ kind: "mystery", title: "没见过的新类型", state: "open" }),
    card({ title: "一张既不在表上也不开着的卡", state: "archived" }),
  ];
  for (const c of hush) {
    const verdict = classify(c);
    assert.equal(verdict.send, false, `不该发的发了：${c.title}（${c.text ?? ""}）`);
    assert.ok(verdict.why, "压下要给个理由");
  }
});

test("classify：设备离线过 2 小时升级成要发", () => {
  const over = card({
    title: "接单程序没连上",
    text: "mbp 已经 185 分钟没连上中台，有 1 件任务在排队或在跑",
    state: "open",
  });
  const verdict = classify(over);
  assert.equal(verdict.send, true);
  assert.equal(verdict.category, "decide");
  const fresh = card({
    title: "接单程序没连上",
    text: "mba 一直没连上中台，有 2 件任务等了 30 分钟没人接",
    state: "open",
  });
  assert.equal(classify(fresh).send, false);
});

test("classify：整类开关与配置规则", () => {
  const ask = card({ kind: "ask", title: "删吗", options: ["删"] });
  const silent = loadPolicy({ send: { decide: false } });
  const verdict = classify(ask, silent);
  assert.equal(verdict.send, false);
  assert.match(verdict.why!, /decide/);
  // 配上去的规则排在默认表前面，第一条命中的说了算
  const custom = loadPolicy({ rules: [{ kind: "ask", to: "result" }] });
  const verdict2 = classify(ask, custom);
  if (!verdict2.send) assert.fail("自定义的 result 规则该放行");
  assert.equal(verdict2.category, "result");
  // 配表可以关掉某一类（微信只回复：关 decide 之后提问卡不推）
  const replyOnly = loadPolicy({ send: { decide: false } });
  assert.equal(classify(card({ title: "做成的事", state: "closed" }), replyOnly).send, true);
});

test("renderOwnerCard：拍板卡带选项与协议号，内容过净身，来源名不直发", () => {
  const text = renderOwnerCard(
    card({
      id: 12,
      kind: "ask",
      title: "「试一下 MBP」要本人处理",
      text: "要本人处理：登录失效\n设备 mbp · Agent Claude Code · 分类：auth_invalid",
      options: ["已恢复，重新派一轮", "先不做了"],
      recommend: 0,
      rule: "试一下 MBP",
    }),
  );
  assert.match(text, /【「试一下 MBP」要本人处理】/);
  assert.match(text, /1\. 已恢复，重新派一轮/);
  assert.match(text, /回复 #12/);
  assert.match(text, /「确认」= 第 1 项/);
  // 设备名、Agent 名是本人的东西，可以留；英文分类代码必须出门。
  assert.match(text, /Agent Claude Code/);
  assert.ok(!/auth_invalid/.test(text), `英文分类代码不该直发：${text}`);
});

test("renderOwnerCard：结果卡不带拍板提示，定了的卡说已定", () => {
  const closed = renderOwnerCard(card({ id: 7, title: "做完了", text: "版本核对完了", state: "closed" }));
  assert.match(closed, /【做完了】/);
  assert.ok(!/回复 #/.test(closed));
  const decided = renderOwnerCard(card({ id: 7, title: "删吗", state: "decided", choice: 1 }));
  assert.match(decided, /已定：第 2 项/);
});
