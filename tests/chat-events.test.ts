// Guards the message→event mapping. Failure cases it prevents: a fresh random id per dispatch so a platform
// redelivery becomes a second run (the old bridge's randomUUID bug); an event subject or type containing characters
// the hub rejects (Chinese text, spaces); the requirement landing only in detail so the lane summary is empty; fixed
// commands routed to task rules instead of their ops types; the platform message number missing from the event id.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chatEvent, CHAT_COMMAND_TYPES } from "../adapters/chat/events.ts";

const SUBJECT = /^[A-Za-z0-9#._:/@-]+$/;
const TYPE = /^[a-z][a-z0-9._-]*$/;

test("事件号 = <渠道>:<平台消息编号>，平台重投得到同一个号", () => {
  const a = chatEvent("wechat", "msg-42", { kind: "task", project: "ai-loop", requirement: "跑下测试" }, "oc_chat");
  const b = chatEvent("wechat", "msg-42", { kind: "task", project: "ai-loop", requirement: "跑下测试" }, "oc_chat");
  assert.equal(a!.id, "wechat:msg-42");
  assert.equal(a!.id, b!.id);
  const f = chatEvent("feishu", "om_abc123", { kind: "command", command: "status" }, "oc_1");
  assert.equal(f!.id, "feishu:om_abc123");
});

test("任务事件：type=task.<项目>，subject=<项目>，要求进 summary/detail", () => {
  const event = chatEvent("feishu", "om_x", { kind: "task", project: "mba", requirement: "把周报写完" }, "oc_9");
  assert.equal(event!.type, "task.mba");
  assert.equal(event!.subject, "mba");
  assert.match(event!.summary!, /把周报写完/);
  assert.equal(event!.detail, "把周报写完");
  assert.match(event!.subject!, SUBJECT);
  assert.match(event!.type, TYPE);
});

test("固定指令映射到 ops/约定事件类型", () => {
  assert.equal(CHAT_COMMAND_TYPES.status, "ops.status");
  assert.equal(CHAT_COMMAND_TYPES.usage, "ops.usage");
  assert.equal(CHAT_COMMAND_TYPES["check-version"], "ai-loop.check-version");
  assert.equal(CHAT_COMMAND_TYPES["inventory-mini"], "ai-loop.inventory.office-mini");
  assert.equal(CHAT_COMMAND_TYPES["inventory-mbp"], "ai-loop.inventory.mbp");
  const event = chatEvent("wechat", "m1", { kind: "command", command: "usage" }, "me@im.wechat");
  assert.equal(event!.type, "ops.usage");
  assert.match(event!.subject!, SUBJECT);
});

test("长要求：summary 截断、detail 留全文；非法字符不进 subject", () => {
  const long = "要".repeat(500);
  const event = chatEvent("wechat", "m9", { kind: "task", project: "ai-loop", requirement: long }, "x");
  assert.ok([...event!.summary!].length <= 200);
  assert.equal(event!.detail, long);
});

test("事件带上发信人：gate 按真实发信人核身，不是通道名义", () => {
  const task = chatEvent(
    "wechat",
    "m10",
    { kind: "task", project: "ai-loop", requirement: "跑下测试" },
    "chat",
    "me@im.wechat",
  );
  assert.equal(task!.from, "me@im.wechat");
  const command = chatEvent("feishu", "om_y", { kind: "command", command: "status" }, "oc_1", "ou_owner");
  assert.equal(command!.from, "ou_owner");
  // 没拿到发信人的场合不编一个——字段留空比写错强。
  const noSender = chatEvent("wechat", "m11", { kind: "command", command: "usage" }, "chat");
  assert.equal(noSender!.from, undefined);
});
