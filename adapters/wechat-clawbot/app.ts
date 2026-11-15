// The WeChat ClawBot entry: iLink long-polls inbound messages, every accepted message refreshes the reply
// credential (context_token), outbound card texts must carry it or they never arrive. State — cursor, token,
// pending cards — lives in a 0600 file so a restart picks up where the last process stopped.
import { hubClient } from "../../protocol/client.ts";
import { loadConfig, loadKeys } from "../chat/config.ts";
import {
  forgetCard,
  loadState,
  markSeen,
  pendingList,
  rememberCard,
  saveState,
  type ChatState,
} from "../chat/state.ts";
import { handleText } from "../chat/act.ts";
import { renderCardText } from "../chat/cards.ts";

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
  const log = opts.log ?? ((line: string) => console.log(`${new Date().toISOString()} ${line}`));
  const save = () => saveState(config.stateFile, state);
  const io = opts.io;

  const source = hubClient(config.hub, keys.source);
  const channel = hubClient(config.hub, keys.channel);

  const send = async (text: string) => {
    if (!config.features.notify) {
      log(`（发通知关着）${text.slice(0, 60)}`);
      return;
    }
    if (!state.contextToken) {
      // Without a fresh credential the transport would still "succeed" while nothing arrives — refuse, log.
      log(`没有回复凭据 context_token，发不出去：${text.slice(0, 60)}`);
      return;
    }
    await io.sendText({ to: config.me, text, contextToken: state.contextToken });
  };

  const deps = { config, state, save, source, channel, channelName: "wechat", numbered: true, send, log };

  async function onMessage(message: WechatMessage) {
    if (message.message_type === 2) return;
    if (message.from_user_id !== config.me) return;
    const msgId = message.message_id;
    if (typeof msgId !== "string" || !msgId) return;
    if (message.context_token) state.contextToken = message.context_token;
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
      await handleText(deps, { msgId, conversation: message.from_user_id, sender: message.from_user_id, text });
    } catch (error) {
      log(`${msgId} 处理失败：${String(error).slice(0, 200)}`);
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
    /** One card round: claim, send its text with the latest credential, report delivered/failed honestly. */
    async deliverOnce(wait = 25) {
      if (!config.features.notify) return false;
      const { card } = (await channel.nextCard(wait)) as {
        card: {
          id: number;
          version: number;
          kind: string;
          title: string;
          text?: string;
          options?: string[];
          recommend?: number | null;
          state?: string;
        } | null;
      };
      if (!card) return false;
      try {
        if (!state.contextToken) throw new Error("没有回复凭据 context_token");
        const { clientId } = await io.sendText({
          to: config.me,
          text: renderCardText(card),
          contextToken: state.contextToken,
        });
        await channel.delivered(card.id, card.version, clientId);
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
        save();
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
