// Guards the message parser. Failure cases it prevents: "10" read as option 1 (the old bridge took only the first
// digit); a fixed command or a project-routing line swallowed as a card answer just because a card is open; a bare
// number or "确认" answering the wrong card when several are open; "#<号>" accepted on a channel that can't map
// numbers to messages; a requirement dispatched with no project chosen; "@<项目>" silently routing to the wrong
// project when the name isn't registered; a colon inside ordinary text misparsed as a project prefix.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAnswerText, parseMessage, type ChatContext } from "../adapters/chat/parse.ts";

const projects = [
  { id: "ai-loop", name: "AI Loop" },
  { id: "mba", name: "MBA" },
];
const ctx = (over: Partial<ChatContext> = {}): ChatContext => ({
  projects,
  current: "ai-loop",
  pending: [],
  numbered: true,
  ...over,
});

test("固定指令永远是固定指令，哪怕有待拍板的卡片", () => {
  const pending = [{ id: 5, options: 3 }];
  for (const [text, command] of [
    ["状态", "status"],
    ["用量", "usage"],
    ["查版本", "check-version"],
    ["盘点 mini", "inventory-mini"],
    ["盘点 mbp", "inventory-mbp"],
  ] as const) {
    assert.deepEqual(parseMessage(text, ctx({ pending })), { kind: "command", command });
  }
  assert.deepEqual(parseMessage("帮助", ctx({ pending })), { kind: "help" });
  assert.deepEqual(parseMessage("项目", ctx({ pending })), { kind: "projects" });
});

test("任务写法：冒号（含全角）和 @ 前缀按已登记项目路由", () => {
  assert.deepEqual(parseMessage("ai-loop：今天做了啥", ctx()), {
    kind: "task",
    project: "ai-loop",
    requirement: "今天做了啥",
  });
  assert.deepEqual(parseMessage("AI Loop: 写个测试", ctx()), {
    kind: "task",
    project: "ai-loop",
    requirement: "写个测试",
  });
  assert.deepEqual(parseMessage("@mba 做个东西", ctx()), {
    kind: "task",
    project: "mba",
    requirement: "做个东西",
  });
  // An unregistered @ name is an explicit misroute attempt: hint, don't guess.
  assert.deepEqual(parseMessage("@云电脑 开机", ctx()), { kind: "unknown-project", name: "云电脑" });
  // A colon in ordinary text is not a project prefix: the whole line stays one requirement.
  assert.deepEqual(parseMessage("帮我看看：今天下午的进度", ctx()), {
    kind: "task",
    project: "ai-loop",
    requirement: "帮我看看：今天下午的进度",
  });
});

test("切到 / 没有当前项目时的取舍", () => {
  assert.deepEqual(parseMessage("切到 mba", ctx()), { kind: "switch", project: "mba" });
  assert.deepEqual(parseMessage("切到 不存在", ctx()), { kind: "unknown-project", name: "不存在" });
  // One registered project needs no choosing.
  const one = ctx({ current: null, projects: projects.slice(0, 1) });
  assert.deepEqual(parseMessage("写个脚本", one), { kind: "task", project: "ai-loop", requirement: "写个脚本" });
  // Several projects and none chosen: ask, don't guess.
  assert.deepEqual(parseMessage("写个脚本", ctx({ current: null })), { kind: "no-project" });
});

test("一张待拍板卡片时序号按完整数字解析，超出范围回提示", () => {
  const pending = [{ id: 5, options: 12 }];
  assert.deepEqual(parseMessage("10", ctx({ pending })), { kind: "answer", card: 5, choice: 9 });
  assert.deepEqual(parseMessage("13", ctx({ pending })), { kind: "answer-hint", reason: "out-of-range", card: 5 });
  assert.deepEqual(parseMessage("0", ctx({ pending })), { kind: "answer-hint", reason: "out-of-range", card: 5 });
  assert.deepEqual(parseMessage("确认", ctx({ pending })), { kind: "answer", card: 5, confirm: true });
  assert.deepEqual(parseMessage("先备份再删", ctx({ pending })), { kind: "answer", card: 5, text: "先备份再删" });
});

test("多张待拍板卡片：必须写卡片号；自由文字仍是任务", () => {
  const pending = [
    { id: 5, options: 3 },
    { id: 7, options: 4 },
  ];
  assert.deepEqual(parseMessage("1", ctx({ pending })), { kind: "answer-hint", reason: "needs-id" });
  assert.deepEqual(parseMessage("确认", ctx({ pending })), { kind: "answer-hint", reason: "needs-id" });
  assert.deepEqual(parseMessage("#7 2", ctx({ pending })), { kind: "answer", card: 7, choice: 1 });
  assert.deepEqual(parseMessage("#7 9", ctx({ pending })), { kind: "answer-hint", reason: "out-of-range", card: 7 });
  assert.deepEqual(parseMessage("#7 确认", ctx({ pending })), { kind: "answer", card: 7, confirm: true });
  assert.deepEqual(parseMessage("#7 重做前一半", ctx({ pending })), { kind: "answer", card: 7, text: "重做前一半" });
  assert.deepEqual(parseMessage("#9 1", ctx({ pending })), { kind: "answer-hint", reason: "no-such-card", card: 9 });
  assert.deepEqual(parseMessage("帮我改一下文档", ctx({ pending })), {
    kind: "task",
    project: "ai-loop",
    requirement: "帮我改一下文档",
  });
});

test("定过的卡不占待拍板数：唯一开着的卡可省号，# 号仍找得到定过的卡", () => {
  // #5 已拍定，#7 是唯一还开着的：裸「1」「确认」和自由文字都归 #7，不被要求写卡号。
  const pending = [
    { id: 5, options: 3, open: false },
    { id: 7, options: 4 },
  ];
  assert.deepEqual(parseMessage("1", ctx({ pending })), { kind: "answer", card: 7, choice: 0 });
  assert.deepEqual(parseMessage("确认", ctx({ pending })), { kind: "answer", card: 7, confirm: true });
  assert.deepEqual(parseMessage("想想再定", ctx({ pending })), { kind: "answer", card: 7, text: "想想再定" });
  // # 号写定过的卡：照交，让中枢回「已经定过了」——不许回「没有这张卡」。
  assert.deepEqual(parseMessage("#5 2", ctx({ pending })), { kind: "answer", card: 5, choice: 1 });
  // 两张开着的才算「多卡」：一张定过、两张开着仍要写卡号。
  const multi = [...pending, { id: 9, options: 2 }];
  assert.deepEqual(parseMessage("1", ctx({ pending: multi })), { kind: "answer-hint", reason: "needs-id" });
  assert.deepEqual(parseMessage("确认", ctx({ pending: multi })), { kind: "answer-hint", reason: "needs-id" });
});

test("不能按编号找消息的通道，# 写法回提示", () => {
  const pending = [{ id: 5, options: 3 }];
  assert.deepEqual(parseMessage("#5 1", ctx({ pending, numbered: false })), {
    kind: "answer-hint",
    reason: "unnumbered",
  });
});

test("拍板正文解析（引用回复用）：完整数字、确认、自由文字", () => {
  assert.deepEqual(parseAnswerText("2", 3, null), { choice: 1 });
  assert.deepEqual(parseAnswerText("10", 12, null), { choice: 9 });
  assert.deepEqual(parseAnswerText("10", 3, null), { outOfRange: true });
  assert.deepEqual(parseAnswerText("确认", 3, 1), { confirm: true });
  assert.deepEqual(parseAnswerText("先备份", 3, null), { text: "先备份" });
});
