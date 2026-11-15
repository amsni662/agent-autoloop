// The real iLink transport for production: thin wrapper over @tencent-weixin/openclaw-weixin, the same package the
// pilot script proved out. Only loaded at runtime — unit tests inject a fake WechatIO instead. The package resolves
// by name when this adapter's own `npm install` ran; deployments that share one install point `transportDir` at it.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { WechatIO, WechatMessage } from "./app.ts";

export type IlinkAccount = { baseUrl: string; token: string; userId: string };

type TransportApi = {
  notifyStart(params: { baseUrl: string; token: string; timeoutMs?: number }): Promise<unknown>;
  notifyStop(params: { baseUrl: string; token: string; timeoutMs?: number }): Promise<unknown>;
  getUpdates(params: {
    baseUrl: string;
    token: string;
    get_updates_buf: string;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
  }): Promise<unknown>;
};
type TransportMessaging = {
  sendMessageWeixin(params: {
    to: string;
    text: string;
    opts: { baseUrl: string; token: string; contextToken?: string; timeoutMs?: number; runId?: string };
  }): Promise<{ messageId: string }>;
};

async function loadTransport(transportDir?: string): Promise<{ api: TransportApi; messaging: TransportMessaging }> {
  if (transportDir) {
    const module = (name: string) => pathToFileURL(join(transportDir, "dist/src", name)).href;
    try {
      return {
        api: await import(module("api/api.js")),
        messaging: await import(module("messaging/send.js")),
      };
    } catch (error) {
      throw new Error(`微信传输包目录 ${transportDir} 读不了：${String(error).slice(0, 150)}`);
    }
  }
  try {
    return {
      api: await import("@tencent-weixin/openclaw-weixin/dist/src/api/api.js"),
      messaging: await import("@tencent-weixin/openclaw-weixin/dist/src/messaging/send.js"),
    };
  } catch (error) {
    throw new Error(
      `找不到微信传输包：在 adapters/wechat-clawbot 目录里跑 npm install，或在配置里加 transportDir 指向它已安装的目录（${String(error).slice(0, 150)}）`,
    );
  }
}

export async function createTransportIO(
  account: IlinkAccount,
  signal?: AbortSignal,
  transportDir?: string,
): Promise<WechatIO> {
  const { api, messaging } = await loadTransport(transportDir);
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
