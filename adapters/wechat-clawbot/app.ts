// The WeChat ClawBot entry: iLink long-polls inbound messages, every accepted message refreshes the reply
// credential (context_token) and stamps its capture time, outbound card texts must carry a credential that is
// still fresh or the platform accepts but never delivers. Outbound text passes the message policy in
// adapters/chat/notify.ts — classification, sanitizing, dedup — before anything leaves. State lives in a 0600
// file so a restart picks up where the last process stopped.
import { hubClient } from "../../protocol/client.ts";
import { loadConfig, loadKeys } from "../chat/config.ts";
import {
  alreadyNotified,
  forgetCard,
  loadState,
  markNotified,
  markSeen,
  pendingList,
  recordSuppressed,
  rememberCard,
  saveState,
  type ChatState,
} from "../chat/state.ts";
import { handleText } from "../chat/act.ts";
import { classify, loadPolicy, renderOwnerCard, sanitize } from "../chat/notify.ts";

export type WechatMessage = {
  message_id?: string;
  from_user_id?: string;
  to_user_id?: string;
  message_type?: number;
  context_token?: string;
  item_list?: { type?: number; text_item?: { text?: string } }[];
};

export type WechatIO = {
  notifyStart(): Promise<unknown>;
  getUpdates(buf: string): Promise<{ get_updates_buf?: string; msgs?: WechatMessage[] }>;
  sendText(args: { to: string; text: string; contextToken: string }): Promise<{ clientId: string }>;
  notifyStop(): Promise<unknown>;
};

export type WechatOpts = {
  configFile: string;
  io: WechatIO;
  log?: (line: string) => void;
};

export async function createWechatApp(opts: WechatOpts) {
  const config = loadConfig(opts.configFile);
  const keys = loadKeys(config.keysFile);
  const state = loadState(config.stateFile);
  const policy = loadPolicy(config.policy);
  const log = opts.log ?? ((line: string) => console.log(`${new Date().toISOString()} ${line}`));
  const save = () => saveState(config.stateFile, state);
  const io = opts.io;

  const source = hubClient(config.hub, keys.source);
  const channel = hubClient(config.hub, keys.channel);

  // The credential gate, shared by replies and card pushes: no token, or a token older than the freshness
  // window, means the platform would accept the send and never deliver — refuse instead of pretending.
  // Default 15min: probes on 2026-11-16 saw a ~56min credential accepted-but-not-delivered (same signature
  // as a 48h one), while the owner confirms fresh replies arrive — the real cutoff is unmeasured, stay low.
  const credentialError = (): string | null => {
    if (!state.contextToken) return "没有回复凭据 context_token";
    const maxAge = config.policy?.tokenMaxAgeMs ?? 15 * 60_000;
    const age = state.contextTokenAt ? Date.now() - Date.parse(state.contextTokenAt) : Infinity;
    if (age > maxAge) return `回复凭据超过 ${Math.round(maxAge / 60_000)} 分钟没刷新，平台不再送达`;
    return null;
  };

  const send = async (text: string) => {
    if (!config.features.notify) {
      log(`（发通知关着）${text.slice(0, 60)}`);
      return;
    }
    const blocked = credentialError();
    if (blocked) {
      // Without a fresh credential the transport would still "succeed" while nothing arrives — refuse, audit.
      log(`${blocked}，发不出去：${text.slice(0, 60)}`);
      recordSuppressed(state, "reply", blocked);
      return;
    }
    await io.sendText({ to: config.me, text: sanitize(text), contextToken: state.contextToken! });
  };

  const deps = { config, state, save, source, channel, channelName: "wechat", numbered: true, send, log };

  async function onMessage(message: WechatMessage) {
    if (message.message_type === 2) return;
    if (message.from_user_id !== config.me) return;
    const msgId = message.message_id;
    if (typeof msgId !== "string" || !msgId) return;
    // Stamp the capture time only when the token value changes: a redelivered message carries the same token,
    // and restamping it would make an old credential look fresh.
    if (message.context_token && message.context_token !== state.contextToken) {
      state.contextToken = message.context_token;
      state.contextTokenAt = new Date().toISOString();
    }
    if (!markSeen(state, msgId)) {
      log(`${msgId} 已处理过，跳过重投`);
      return;
    }
    const text = (message.item_list ?? [])
      .filter((item) => item.type === 1 && item.text_item?.text)
      .map((item) => item.text_item!.text!)
      .join("\n")
      .trim();
    if (!text) {
      save();
      return;
    }
    try {
      const kind = await handleText(deps, {
        msgId,
        conversation: message.from_user_id,
        sender: message.from_user_id,
        text,
      });
      // 顺带提一句有待拍板的事——微信只回复不主动推，等处理的事在回复里露个脸（清单 3.4）。
      if (kind !== "answer" && kind !== "answer-hint" && kind !== "ignore") {
        const pending = pendingList(state);
        if (pending.length) {
          await send(
            `另外有 ${pending.length} 件事等你拍板（${pending.map((c) => `#${c.id}`).join("、")}），回复「#卡号 <序号或一句话>」`,
          );
        }
      }
    } catch (error) {
      log(`${msgId} 处理失败：${String(error).slice(0, 200)}`);
      // The reply path only needs the credential, not the hub — still tell the owner it didn't go through.
      await send("这句没处理成，中台那边没答上，过会儿再试。").catch(() => {});
    }
    save();
  }

  let online = false;
  return {
    /** One getUpdates round: fetch a batch, handle every accepted message, then persist the cursor. */
    async pollOnce() {
      if (!config.features.intake) return;
      if (!online) {
        await io.notifyStart();
        online = true;
      }
      const data = await io.getUpdates(state.cursor ?? "");
      for (const message of data.msgs ?? []) await onMessage(message);
      if (typeof data.get_updates_buf === "string" && data.get_updates_buf !== state.cursor) {
        state.cursor = data.get_updates_buf;
        save();
      }
    },
    /** One card round: policy first — suppress, dedup, credential freshness — then send and report honestly. */
    async deliverOnce(wait = 25) {
      if (!config.features.notify) return false;
      const { card } = (await channel.nextCard(wait)) as {
        card: {
          id: number;
          version: number;
          kind: string;
          title: string;
          text?: string;
          detail?: string;
          options?: string[];
          recommend?: number | null;
          state?: string;
          rule?: string;
        } | null;
      };
      if (!card) return false;
      try {
        const verdict = classify(card, policy);
        if (!verdict.send) {
          // Policy held it back: mark this version handled (ref stays null — nothing was sent) and audit why.
          // The card itself stays in hub state and on the dashboard either way.
          await channel.delivered(card.id, card.version, null);
          recordSuppressed(state, `card:${card.id}:${card.title}`, verdict.why);
          save();
          return true;
        }
        if (alreadyNotified(state, card.id, card.version)) {
          // This version already went out (the ack got lost, or a retry came back): re-ack with the ref we
          // used the first time so a lost delivery report heals without a second message.
          await channel.delivered(card.id, card.version, state.cards[String(card.id)]?.ref ?? null);
          return true;
        }
        const blocked = credentialError();
        if (blocked) {
          // A missing or stale credential gets accepted-but-never-delivered from the platform: fail honestly.
          throw new Error(blocked);
        }
        const { clientId } = await io.sendText({
          to: config.me,
          text: renderOwnerCard(card),
          contextToken: state.contextToken!,
        });
        if (card.state === "open") {
          rememberCard(state, {
            id: card.id,
            ref: clientId,
            options: (card.options ?? []).length,
            kind: card.kind,
            title: card.title,
            recommend: card.recommend ?? null,
          });
        } else {
          forgetCard(state, card.id);
        }
        // Mark before the ack: a crash after the send must not send the text twice on re-offer.
        markNotified(state, card.id, card.version);
        save();
        await channel.delivered(card.id, card.version, clientId);
      } catch (error) {
        await channel.failed(card.id, card.version, String(error).slice(0, 200)).catch(() => {});
        log(`卡片 ${card.id} 没发出去：${String(error).slice(0, 120)}`);
      }
      return true;
    },
    async stop() {
      save();
      if (online) await io.notifyStop().catch(() => {});
    },
    // Tests and the runner share these.
    state: state as ChatState,
    pending: () => pendingList(state),
  };
}
