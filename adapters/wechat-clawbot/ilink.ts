// The real iLink transport for production: thin wrapper over @tencent-weixin/openclaw-weixin, the same package the
// pilot script proved out. Only loaded at runtime — unit tests inject a fake WechatIO instead.
import type { WechatIO, WechatMessage } from "./app.ts";

export type IlinkAccount = { baseUrl: string; token: string; userId: string };

export async function createTransportIO(account: IlinkAccount, signal?: AbortSignal): Promise<WechatIO> {
  const api = await import("@tencent-weixin/openclaw-weixin/dist/src/api/api.js");
  const messaging = await import("@tencent-weixin/openclaw-weixin/dist/src/messaging/send.js");
  const { baseUrl, token } = account;
  return {
    notifyStart: () => api.notifyStart({ baseUrl, token, timeoutMs: 12_000 }),
    notifyStop: () => api.notifyStop({ baseUrl, token, timeoutMs: 12_000 }),
    getUpdates: async (buf: string) =>
      (await api.getUpdates({
        baseUrl,
        token,
        get_updates_buf: buf,
        timeoutMs: 38_000,
        abortSignal: signal,
      })) as { get_updates_buf?: string; msgs?: WechatMessage[] },
    sendText: async ({ to, text, contextToken }) => {
      const { messageId } = await messaging.sendMessageWeixin({
        to,
        text,
        opts: { baseUrl, token, contextToken, timeoutMs: 12_000 },
      });
      return { clientId: messageId };
    },
  };
}
