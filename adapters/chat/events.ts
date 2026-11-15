// Message → hub event. The event id is the channel's name for the platform's own message number, so a redelivery
// names the same event and the hub dedups it. Text is data: the requirement rides in detail/summary and never
// picks the agent — that's the rule's job.
import type { Action } from "./parse.ts";

export const CHAT_COMMAND_TYPES = {
  status: "ops.status",
  usage: "ops.usage",
  "check-version": "ai-loop.check-version",
  "inventory-mini": "ai-loop.inventory.office-mini",
  "inventory-mbp": "ai-loop.inventory.mbp",
} as const;

export type ChatEvent = { id: string; type: string; subject?: string; summary?: string; detail?: string };

export function chatEvent(channel: string, messageId: string, action: Action, conversation: string): ChatEvent | null {
  const id = `${channel}:${messageId}`;
  if (action.kind === "command") {
    return { id, type: CHAT_COMMAND_TYPES[action.command], subject: conversation, summary: `指令：${action.command}` };
  }
  if (action.kind === "task") {
    return {
      id,
      type: `task.${action.project}`,
      subject: action.project,
      summary: [...action.requirement].slice(0, 200).join(""),
      detail: action.requirement,
    };
  }
  return null;
}
