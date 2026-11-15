// What an incoming line means. Fixed commands and project-routing text are checked before card answers: an
// instruction is never eaten by an open card. Numbers are parsed whole ("10" is the tenth option, never the
// first); with more than one open card a bare "1" or "确认" asks for the card number rather than guessing.
import { resolveProject, type Project } from "./projects.ts";

export type PendingRef = { id: number; options: number; kind?: string };
export type ChatContext = {
  projects: Project[];
  current: string | null;
  pending: PendingRef[];
  /** Whether "#<卡片号>" can name a card on this channel (WeChat yes, Feishu no). */
  numbered: boolean;
};

export type Action =
  | { kind: "ignore" }
  | { kind: "command"; command: keyof typeof COMMANDS }
  | { kind: "help" }
  | { kind: "projects" }
  | { kind: "switch"; project: string }
  | { kind: "task"; project: string; requirement: string }
  | { kind: "answer"; card: number; choice?: number; confirm?: boolean; text?: string }
  | {
      kind: "answer-hint";
      reason: "no-such-card" | "out-of-range" | "needs-id" | "unnumbered" | "empty-task" | "show-card";
      card?: number;
    }
  | { kind: "unknown-project"; name: string }
  | { kind: "no-project" };

const COMMANDS = {
  status: "状态",
  usage: "用量",
  "check-version": "查版本",
  "inventory-mini": "盘点 mini",
  "inventory-mbp": "盘点 mbp",
} as const;

const squash = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

const answerTo = (card: PendingRef, text: string): Action => {
  const body = text.trim();
  if (card.kind === "notice") {
    if (/^(1|确认)$/.test(body)) return { kind: "answer", card: card.id, confirm: true };
    if (/^\d+$/.test(body)) return { kind: "answer-hint", reason: "out-of-range", card: card.id };
    return { kind: "answer", card: card.id, text: body };
  }
  if (/^\d+$/.test(body)) {
    const n = Number(body);
    return n >= 1 && n <= card.options
      ? { kind: "answer", card: card.id, choice: n - 1 }
      : { kind: "answer-hint", reason: "out-of-range", card: card.id };
  }
  if (body === "确认") return { kind: "answer", card: card.id, confirm: true };
  return { kind: "answer", card: card.id, text: body };
};

export function parseMessage(raw: string, ctx: ChatContext): Action {
  const text = raw.trim();
  if (!text) return { kind: "ignore" };

  const fixed = squash(text);
  for (const [command, words] of Object.entries(COMMANDS)) {
    if (fixed === words) return { kind: "command", command: command as keyof typeof COMMANDS };
  }
  if (fixed === "帮助") return { kind: "help" };
  if (fixed === "项目") return { kind: "projects" };

  if (fixed === "切到") return { kind: "projects" };
  const switching = /^切到\s*(.+)$/.exec(text);
  if (switching) {
    const project = resolveProject(switching[1], ctx.projects);
    return project ? { kind: "switch", project } : { kind: "unknown-project", name: switching[1].trim() };
  }

  const numbered = /^#\s*(\d+)\s*(.*)$/.exec(text);
  if (numbered) {
    if (!ctx.numbered) return { kind: "answer-hint", reason: "unnumbered" };
    const card = ctx.pending.find((item) => item.id === Number(numbered[1]));
    if (!card) return { kind: "answer-hint", reason: "no-such-card", card: Number(numbered[1]) };
    const body = numbered[2].trim();
    return body ? answerTo(card, body) : { kind: "answer-hint", reason: "show-card", card: card.id };
  }

  const at = /^@(\S+)\s*(.*)$/.exec(text);
  if (at) {
    const project = resolveProject(at[1], ctx.projects);
    if (!project) return { kind: "unknown-project", name: at[1] };
    const requirement = at[2].trim();
    return requirement ? { kind: "task", project, requirement } : { kind: "answer-hint", reason: "empty-task" };
  }

  // "<项目>：<要求>" only counts when the head really names a registered project; a colon inside ordinary text
  // stays ordinary text and goes to the current project whole.
  const colon = /^(.{1,30}?)[：:]\s*(.*)$/s.exec(text);
  if (colon) {
    const project = resolveProject(colon[1], ctx.projects);
    if (project) {
      const requirement = colon[2].trim();
      return requirement ? { kind: "task", project, requirement } : { kind: "answer-hint", reason: "empty-task" };
    }
  }

  if (ctx.pending.length === 1) return answerTo(ctx.pending[0], text);
  if (ctx.pending.length > 1 && /^(\d+|确认)$/.test(text)) return { kind: "answer-hint", reason: "needs-id" };

  if (!ctx.current) {
    if (ctx.projects.length === 1) return { kind: "task", project: ctx.projects[0].id, requirement: text };
    return { kind: "no-project" };
  }
  return { kind: "task", project: ctx.current, requirement: text };
}

/** What a quoted reply says about a card: an option number, "确认" or free text. */
export function parseAnswerText(
  raw: string,
  options: number,
  recommend: number | null,
  kind = "ask",
): { choice?: number; confirm?: boolean; text?: string; outOfRange?: boolean } {
  const action = answerTo({ id: 0, options, kind }, raw);
  if (action.kind === "answer") {
    const out: { choice?: number; confirm?: boolean; text?: string } = {};
    if (action.choice !== undefined) out.choice = action.choice;
    if (action.confirm) out.confirm = true;
    if (action.text !== undefined) out.text = action.text;
    return out;
  }
  if (action.kind === "answer-hint" && action.reason === "out-of-range") return { outOfRange: true };
  return { text: raw.trim() };
}
