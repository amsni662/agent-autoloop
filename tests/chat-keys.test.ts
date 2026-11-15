// Guards the chat adapters' least-privilege key split over a real HTTP hub. Failure cases it prevents: an adapter
// holding the owner key (the old bridge read it straight out of config.json); a source key used for card answers or
// a channel key used to emit events; a same-id resend dispatching twice (the hub's dedup is only reached because
// the event id is the stable platform message id, not a random one); the secrets file carrying anything beyond the
// two keys the adapter needs.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";

const dir = setup("chat-keys", join(import.meta.dirname, "chat.fixture.json"));
const { serve } = await import("../host/http.ts");
const hubFns = await import("./hub.ts");
const { hubClient, HubError } = await import("../protocol/client.ts");
const { loadKeys } = await import("../adapters/chat/config.ts");

const server = serve(0);
await new Promise((resolve) => server.once("listening", resolve));
after(() => {
  server.closeAllConnections();
  server.close();
});
const base = `http://127.0.0.1:${(server.address() as any).port}`;

const owner = hubFns.addKey("owner", "owner");
const source = hubFns.addKey("source", "wechat");
const channel = hubFns.addKey("channel", "wechat");

test("来源密钥不能回答卡片/查全局，通道密钥不能发事件，都没有本人权限", async () => {
  const asSource = hubClient(base, source);
  const asChannel = hubClient(base, channel);
  await assert.rejects(() => asSource.state(), HubError);
  await assert.rejects(() => asSource.answer(1, { choice: 0 }), HubError);
  await assert.rejects(() => asChannel.event({ id: "x:1", type: "ops.status" }), HubError);
  await assert.rejects(() => asChannel.state(), HubError);
  // The adapter's own two keys are enough for its whole job:
  await asSource.event({ id: "wechat:m1", type: "ops.status", subject: "chat" });
  await asChannel.nextCard(0);
});

test("同一平台消息编号重复送达：中枢只认一条（幂等键是事件 id）", async () => {
  const asSource = hubClient(base, source);
  const first = await asSource.event({ id: "wechat:dup-1", type: "ops.status", subject: "chat" });
  const again = await asSource.event({ id: "wechat:dup-1", type: "ops.status", subject: "chat" });
  assert.equal(first.duplicate, false);
  assert.equal(again.duplicate, true);
});

test("密钥文件只有来源、通道两把钥匙；缺任一把都起不来", async () => {
  const file = join(dir, "keys.json");
  writeFileSync(file, JSON.stringify({ source, channel }), { mode: 0o600 });
  assert.deepEqual(loadKeys(file), { source, channel });
  const noChannel = join(dir, "half.json");
  writeFileSync(noChannel, JSON.stringify({ source }), { mode: 0o600 });
  assert.throws(() => loadKeys(noChannel), /channel/);
});
