// One incoming text, one action: emit an event, list/switch projects, submit a card answer, or send a hint back.
// Replies go through `send` — already gated by the caller's switches — and hub calls only ever use the source and
// channel keys this process was given.
import { HubError, type Hub } from "../../protocol/client.ts";
import { describeProjects, loadProjects, type Project } from "./projects.ts";
import { chatEvent } from "./events.ts";
import { parseMessage, type Action } from "./parse.ts";
import { pendingList, type ChatState, type PendingCard } from "./state.ts";
import type { ChatConfig } from "./config.ts";

export type ChatDeps = {
  config: ChatConfig;
  state: ChatState;
  save: () => void;
  source: Hub;
  channel: Hub;
  channelName: string;
  numbered: boolean;
  send: (text: string) => Promise<void>;
  log: (line: string) => void;
};

const HELP = {
  numbered: `能发的消息：
- 状态 / 用量 / 查版本 / 盘点 mini / 盘点 mbp —— 固定指令
- 项目 —— 看已登记的项目和当前项目；切到 <项目> —— 换当前项目
- <项目>：<要求> 或 @<项目> <要求> —— 指定项目派活；不带项目就用当前项目
- 等你拍板时：回复 #<卡片号> <序号>，或 #<卡片号> 确认，或 #<卡片号> <一句话>；只有一张待拍板时可直接写序号/确认/一句话`,
  unnumbered: `能发的消息：
- 状态 / 用量 / 查版本 / 盘点 mini / 盘点 mbp —— 固定指令
- 项目 —— 看已登记的项目和当前项目；切到 <项目> —— 换当前项目
- <项目>：<要求> 或 @<项目> <要求> —— 指定项目派活；不带项目就用当前项目
- 拍板：点卡片上的按钮，或在卡片里的文字框写回答；也可以引用回复那张卡片写「#卡片号 <序号或一句话>」`,
};

export const helpText = (numbered: boolean) => (numbered ? HELP.numbered : HELP.unnumbered);

async function dispatch(
  deps: ChatDeps,
  action: Action,
  conversation: string,
  msgId: string,
  sender: string,
): Promise<void> {
  const event = chatEvent(deps.channelName, msgId, action, conversation, sender);
  if (!event) return;
  const ack = (await deps.source.event(event)) as { duplicate?: boolean; routed?: string[] };
  if (ack.duplicate) {
    deps.log(`${msgId} 中台已收过，跳过重投`);
    return;
  }
  await deps.send(
    ack.routed?.length ? `已派给「${ack.routed.join("」「")}」` : "中台收到了，但这句没有规矩接，没派出去。",
  );
}

async function submitAnswer(deps: ChatDeps, action: Extract<Action, { kind: "answer" }>, by: string): Promise<void> {
  if (!deps.config.features.answers) {
    await deps.send("拍板功能没开，回答没交");
    return;
  }
  const pending = deps.state.cards[String(action.card)];
  if (!pending) {
    await deps.send(`没有待拍板的卡片 #${action.card}`);
    return;
  }
  const body: { choice?: number; text?: string; by: string; ref: string } = { by, ref: pending.ref };
  if (action.choice !== undefined) body.choice = action.choice;
  else if (action.confirm) body.choice = pending.kind === "notice" ? 0 : (pending.recommend ?? 0);
  else body.text = action.text;
  try {
    const result = (await deps.channel.answer(action.card, body)) as { changed: boolean; state: string };
    if (!result.changed) {
      await deps.send(`卡片 #${action.card} 已经定过了`);
    } else {
      const what = body.text ?? `第 ${(body.choice ?? 0) + 1} 项`;
      await deps.send(`已记下：${what}`);
    }
    // Keep the index entry until the hub reoffers the card in its decided state — a duplicate answer before then
    // still reaches the kernel and gets the honest "already decided", not "no such card".
  } catch (error) {
    await deps.send(`这个回答没被收下：${error instanceof HubError ? error.message : String(error)}`);
  }
}

/** Handles one inbound text; returns the action kind so the caller can decide follow-ups (e.g. pending hints). */
export async function handleText(
  deps: ChatDeps,
  opts: { msgId: string; conversation: string; sender: string; text: string },
): Promise<Action["kind"]> {
  const { msgId, conversation, sender, text } = opts;
  const projects: Project[] = loadProjects(deps.config.rulesFile);
  const action = parseMessage(text, {
    projects,
    current: deps.state.currentProject,
    pending: pendingList(deps.state).map(({ id, options, kind }) => ({ id, options, kind })),
    numbered: deps.numbered,
  });
  deps.log(`${msgId} → ${action.kind}`);

  switch (action.kind) {
    case "ignore":
      break;
    case "command":
    case "task":
      await dispatch(deps, action, conversation, msgId, sender);
      break;
    case "help":
      await deps.send(helpText(deps.numbered));
      break;
    case "projects":
      await deps.send(describeProjects(projects, deps.state.currentProject));
      break;
    case "switch":
      deps.state.currentProject = action.project;
      deps.save();
      await deps.send(`当前项目：${projects.find((p) => p.id === action.project)?.name ?? action.project}`);
      break;
    case "no-project":
      await deps.send(`没说给哪个项目。\n${describeProjects(projects, null)}\n写「<项目>：<要求>」或先「切到 <项目>」`);
      break;
    case "unknown-project":
      await deps.send(`没登记的项目「${action.name}」。\n${describeProjects(projects, deps.state.currentProject)}`);
      break;
    case "answer":
      await submitAnswer(deps, action, sender);
      break;
    case "answer-hint": {
      if (!deps.config.features.answers) {
        await deps.send("拍板功能没开，回答没交");
        break;
      }
      const pending = pendingList(deps.state);
      switch (action.reason) {
        case "needs-id":
          await deps.send(
            `有 ${pending.length} 张卡片等你拍板（${pending.map((c) => `#${c.id}`).join("、")}），写「#卡片号 <序号或一句话>」`,
          );
          break;
        case "no-such-card":
          await deps.send(
            `没有待拍板的卡片 #${action.card}${pending.length ? `（在等：${pending.map((c) => `#${c.id}`).join("、")}）` : ""}`,
          );
          break;
        case "out-of-range": {
          const card = pending.find((c) => c.id === action.card);
          await deps.send(`卡片 #${action.card} 没有这项（共 ${card?.options ?? "?"} 项）`);
          break;
        }
        case "unnumbered":
          await deps.send(
            "这里拍板：点卡片上的按钮、在卡片里的文字框写回答，或引用回复卡片消息写「#卡片号 <序号或一句话>」",
          );
          break;
        case "empty-task":
          await deps.send("要求没写。写「<项目>：<要求>」或「@<项目> <要求>」");
          break;
        case "show-card": {
          const card = pending.find((c) => c.id === action.card);
          await deps.send(
            card
              ? `卡片 #${card.id}「${card.title}」共 ${card.options} 项，写「#${card.id} <序号或一句话>」`
              : `没有待拍板的卡片 #${action.card}`,
          );
          break;
        }
      }
      break;
    }
  }
  return action.kind;
}
