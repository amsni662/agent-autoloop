// The Feishu chat entry: lark-cli holds the app's credentials and the event stream; this process decides what an
// incoming line means and talks to the hub with only a source key and a channel key.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { hubClient, HubError } from "../../protocol/client.ts";
import { loadConfig, loadKeys, type ChatConfig } from "../chat/config.ts";
import { loadState, markSeen, saveState, type ChatState } from "../chat/state.ts";
import { handleText } from "../chat/act.ts";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type FeishuOpts = {
  configFile: string;
  lark?: string;
  restartMs?: number;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
};

export async function createFeishuApp(opts: FeishuOpts) {
  const config = loadConfig(opts.configFile);
  const keys = loadKeys(config.keysFile);
  const state = loadState(config.stateFile);
  const log = opts.log ?? ((line: string) => console.log(`${new Date().toISOString()} ${line}`));
  const save = () => saveState(config.stateFile, state);
  const lark = opts.lark ?? config.lark ?? "lark-cli";
  const restartMs = opts.restartMs ?? 10_000;

  const source = hubClient(config.hub, keys.source);
  const channel = hubClient(config.hub, keys.channel);

  let sentKey = 0;
  const send = async (text: string) => {
    if (!config.features.notify) {
      log(`（发通知关着）${text.slice(0, 60)}`);
      return;
    }
    try {
      await exec(
        lark,
        [
          "im",
          "+messages-send",
          "--user-id",
          config.me,
          "--as",
          "bot",
          "--msg-type",
          "text",
          "--idempotency-key",
          `chat-reply-${sentKey++}`,
          "--content",
          JSON.stringify({ text }),
        ],
        { env: opts.env ?? process.env },
      );
    } catch (error) {
      log(`回复没发出去：${String(error).slice(0, 200)}`);
    }
  };

  const deps = {
    config,
    state,
    save,
    source,
    channel,
    channelName: "feishu",
    numbered: false,
    send,
    log,
  };

  /** A quoted reply to a card message can be an answer — only when the text itself carries the card number. */
  async function quoteAnswer(msgId: string, sender: string, text: string, ref: string) {
    const numbered = /^#\s*(\d+)\s*(.*)$/.exec(text);
    if (!numbered) {
      await send("要拍板：点卡片上的按钮、在卡片里的文字框写回答，或写「#卡片号 <序号或一句话>」引用回复那张卡片");
      return;
    }
    if (!config.features.answers) {
      await send("拍板功能没开，回答没交");
      return;
    }
    const body: { choice?: number; text?: string; by: string; ref: string } = { by: sender, ref };
    const [, , words] = numbered;
    if (/^\d+$/.test(words.trim())) body.choice = Number(words.trim()) - 1;
    else if (words.trim()) body.text = words.trim();
    else {
      await send("写全一点：「#卡片号 <序号或一句话>」");
      return;
    }
    try {
      const result = (await channel.answer(Number(numbered[1]), body)) as { changed: boolean };
      await send(result.changed ? `已记下：${body.text ?? `第 ${(body.choice ?? 0) + 1} 项`}` : "这张卡片已经定过了");
    } catch (error) {
      await send(`这个回答没被收下：${error instanceof HubError ? error.message : String(error)}`);
    }
  }

  let inflight = 0;
  const settle = () =>
    new Promise<void>((resolve) => {
      const tick = () => (inflight === 0 ? resolve() : setTimeout(tick, 20));
      tick();
    });

  async function onEvent(raw: unknown) {
    const event = raw as Record<string, string>;
    if (event.message_type !== "text" || typeof event.content !== "string") return;
    if (event.sender_type !== "user" || event.sender_id !== config.me) return;
    if (event.chat_type !== "p2p") return;
    const msgId = event.message_id;
    if (typeof msgId !== "string" || !msgId) return;
    if (!markSeen(state, msgId)) {
      log(`${msgId} 已处理过，跳过重投`);
      return;
    }
    save();
    inflight += 1;
    try {
      if (typeof event.reply_to === "string" && event.reply_to) {
        await quoteAnswer(msgId, event.sender_id, event.content.trim(), event.reply_to);
      } else {
        await handleText(deps, {
          msgId,
          conversation: event.chat_id ?? "p2p",
          sender: event.sender_id,
          text: event.content,
        });
      }
    } catch (error) {
      log(`${msgId} 处理失败：${String(error).slice(0, 200)}`);
    } finally {
      inflight -= 1;
    }
  }

  let stopped = false;
  let child: ChildProcess | null = null;
  let exits = 0;
  let exitedResolve: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function consume() {
    child = spawn(lark, ["event", "consume", "im.message.receive_v1", "--as", "bot"], {
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "inherit"],
    });
    // lark-cli ends an unbounded consume when its stdin closes — keep it open until stop().
    child.stdout!.setEncoding("utf8");
    let buffer = "";
    child.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("{")) continue;
        try {
          void onEvent(JSON.parse(line));
        } catch {
          log(`一行没解析成事件：${line.slice(0, 120)}`);
        }
      }
    });
    let retry: ReturnType<typeof setTimeout> | null = null;
    const exited = (code: number | null) => {
      exits += 1;
      exitedResolve?.();
      if (stopped) return;
      log(`事件监听断了（${code}），${restartMs / 1000} 秒后重连`);
      retry = setTimeout(() => !stopped && consume(), restartMs);
      retry.unref?.();
      timer = retry;
    };
    child.on("exit", exited);
    child.on("error", () => exited(null));
  }

  if (config.features.intake) consume();

  return {
    async drain() {
      if (!config.features.intake) return;
      await new Promise<void>((resolve) => {
        if (!child || child.exitCode === null) exitedResolve = resolve;
        else resolve();
      });
      await settle();
    },
    restarts: () => exits,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      child?.kill("SIGTERM");
      await sleep(50);
      save();
    },
  };
}

export type { ChatConfig, ChatState };
