// Type declarations for the transport package's untyped dist files so `npm run typecheck` passes on a checkout
// where this adapter's own `npm install` hasn't run. When node_modules is present the real package resolves first.
declare module "@tencent-weixin/openclaw-weixin/dist/src/api/api.js" {
  export function notifyStart(params: { baseUrl: string; token: string; timeoutMs?: number }): Promise<unknown>;
  export function notifyStop(params: { baseUrl: string; token: string; timeoutMs?: number }): Promise<unknown>;
  export function getUpdates(params: {
    baseUrl: string;
    token: string;
    get_updates_buf: string;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
  }): Promise<unknown>;
}
declare module "@tencent-weixin/openclaw-weixin/dist/src/messaging/send.js" {
  export function sendMessageWeixin(params: {
    to: string;
    text: string;
    opts: { baseUrl: string; token: string; contextToken?: string; timeoutMs?: number; runId?: string };
  }): Promise<{ messageId: string }>;
}
