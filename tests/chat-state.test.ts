// Guards the chat adapter's state file. Failure cases it prevents: the WeChat get_updates_buf cursor or the reply
// credential living only in memory, so a restart refetches and redispatches old messages or loses the means to reply;
// the file readable by anyone but the owner (it holds credentials); a torn write leaving half JSON; a corrupt file
// crashing the adapter into a restart loop; the seen-message set growing without bound; a delivered card's index
// forgotten so its number no longer answers.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  forgetCard,
  loadState,
  markSeen,
  pendingList,
  rememberCard,
  saveState,
  SEEN_CAP,
} from "../adapters/chat/state.ts";

const dir = mkdtempSync(join(tmpdir(), "chat-state-"));
const file = join(dir, "state.json");

test("状态文件：往返、0600、原子写不留临时文件", () => {
  const state = loadState(file);
  state.currentProject = "ai-loop";
  state.cursor = "buf-9";
  state.contextToken = "token-keep-private";
  rememberCard(state, { id: 5, ref: "client-1", options: 3, kind: "ask", title: "删缓存吗", recommend: 0 });
  saveState(file, state);

  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ["state.json"]);
  const again = loadState(file);
  assert.equal(again.currentProject, "ai-loop");
  assert.equal(again.cursor, "buf-9");
  assert.equal(again.contextToken, "token-keep-private");
  assert.deepEqual(pendingList(again), [
    { id: 5, ref: "client-1", options: 3, kind: "ask", title: "删缓存吗", recommend: 0 },
  ]);
});

test("已见消息编号去重并有上限", () => {
  const state = loadState(join(dir, "seen.json"));
  assert.equal(markSeen(state, "m1"), true);
  assert.equal(markSeen(state, "m1"), false);
  for (let i = 0; i < SEEN_CAP + 50; i++) markSeen(state, `m${i}`);
  assert.ok(state.seen.length <= SEEN_CAP);
  assert.equal(markSeen(state, "brand-new"), true);
});

test("卡片索引：关掉/定掉的卡片不再算待拍板", () => {
  const state = loadState(join(dir, "cards.json"));
  rememberCard(state, { id: 5, ref: "r1", options: 2, kind: "ask", title: "a", recommend: null });
  rememberCard(state, { id: 6, ref: "r2", options: 0, kind: "notice", title: "b", recommend: null });
  assert.equal(pendingList(state).length, 2);
  forgetCard(state, 5);
  assert.deepEqual(
    pendingList(state).map((c) => c.id),
    [6],
  );
});

test("状态文件损坏：不崩，挪到 .corrupt 后从头来", () => {
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{not json", { mode: 0o600 });
  const state = loadState(bad);
  assert.equal(state.currentProject, null);
  assert.ok(readdirSync(dir).includes("bad.json.corrupt"));
});
