// A fake iLink service plus a thin client, for the WeChat ClawBot adapter tests. The server speaks the same JSON
// endpoints the transport package calls (notifystart / getupdates / sendmessage / notifystop): scripted inbound
// batches, a recording of every sendmessage body (so tests verify context_token really went out), and a cursor the
// test asserts the adapter persisted and resumed from. No real message ever leaves the process.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { WechatMessage } from "../adapters/wechat-clawbot/app.ts";

export async function startFakeIlink() {
  const calls: { sends: any[]; updates: string[]; notifyStart: number; notifyStop: number } = {
    sends: [],
    updates: [],
    notifyStart: 0,
    notifyStop: 0,
  };
  let cursor = "buf-0";
  const queue: WechatMessage[] = [];
  const server = createServer(async (req, res) => {
    const body = await new Promise<any>((resolve) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => resolve(data ? JSON.parse(data) : {}));
    });
    const reply = (value: unknown) => {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
    };
    if (req.url!.endsWith("/notifystart")) {
      calls.notifyStart += 1;
      return reply({ ret: 0 });
    }
    if (req.url!.endsWith("/notifystop")) {
      calls.notifyStop += 1;
      return reply({ ret: 0 });
    }
    if (req.url!.endsWith("/getupdates")) {
      calls.updates.push(body.get_updates_buf ?? "");
      const msgs = queue.splice(0);
      cursor = `buf-${calls.updates.length}`;
      return reply({ ret: 0, get_updates_buf: cursor, msgs });
    }
    if (req.url!.endsWith("/sendmessage")) {
      calls.sends.push(body);
      return reply({ ret: 0 });
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  return {
    baseUrl,
    calls,
    feed: (msgs: WechatMessage[]) => queue.push(...msgs),
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

// The test-side client mirrors what the transport package does for us: generate the client id, put the context
// token on the message, read the cursor field back.
export function thinIlinkClient(baseUrl: string) {
  const post = async (path: string, body: unknown) => {
    const response = await fetch(baseUrl + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`ilink ${path}: ${response.status}`);
    return response.json();
  };
  return {
    notifyStart: () => post("/ilink/bot/notifystart", {}),
    notifyStop: () => post("/ilink/bot/notifystop", {}),
    getUpdates: (buf: string) => post("/ilink/bot/getupdates", { get_updates_buf: buf }),
    async sendText({ to, text, contextToken }: { to: string; text: string; contextToken: string }) {
      const clientId = `client-${randomUUID()}`;
      const msg: Record<string, unknown> = {
        to_user_id: to,
        item_list: [{ type: 1, text_item: { text } }],
        client_id: clientId,
      };
      if (contextToken) msg.context_token = contextToken;
      await post("/ilink/bot/sendmessage", { msg });
      return { clientId };
    },
  };
}

export const inboundText = (over: Partial<WechatMessage> & { text?: string } = {}): WechatMessage => ({
  message_id: over.message_id ?? `wx-${Math.random().toString(36).slice(2)}`,
  from_user_id: "me@im.wechat",
  to_user_id: "bot",
  message_type: 1,
  context_token: "ctx-secret-token",
  item_list: [{ type: 1, text_item: { text: over.text ?? "你好" } }],
  ...over,
});
