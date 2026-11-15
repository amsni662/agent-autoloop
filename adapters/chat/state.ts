// Per-adapter state: the platform cursor, the reply credential, the current project and the index of cards waiting
// for an answer. It holds secrets (context_token), so it's always written 0600 and atomically.
import { chmodSync, existsSync, mkdirSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const SEEN_CAP = 500;

export type PendingCard = {
  id: number;
  /** The ref the hub checks answers against: the clientId of the first delivery we reported. */
  ref: string;
  options: number;
  kind: string;
  title: string;
  recommend: number | null;
};

export type ChatState = {
  currentProject: string | null;
  seen: string[];
  cursor?: string;
  contextToken?: string | null;
  cards: Record<string, PendingCard>;
};

const fresh = (): ChatState => ({ currentProject: null, seen: [], cards: {} });

export function loadState(file: string): ChatState {
  if (!existsSync(file)) return fresh();
  try {
    const state = JSON.parse(readFileSync(file, "utf8")) as ChatState;
    state.seen ??= [];
    state.cards ??= {};
    state.currentProject ??= null;
    return state;
  } catch {
    renameSync(file, `${file}.corrupt`);
    return fresh();
  }
}

export function saveState(file: string, state: ChatState): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

/** First sight returns true; an id already kept returns false so the message is skipped. */
export function markSeen(state: ChatState, id: string): boolean {
  if (state.seen.includes(id)) return false;
  state.seen.push(id);
  if (state.seen.length > SEEN_CAP) state.seen.splice(0, state.seen.length - SEEN_CAP);
  return true;
}

export function rememberCard(state: ChatState, card: PendingCard): void {
  // The hub keeps the first ref we reported; never overwrite it with a later send's clientId.
  state.cards[String(card.id)] ??= card;
}

export function forgetCard(state: ChatState, id: number): void {
  delete state.cards[String(id)];
}

export const pendingList = (state: ChatState): PendingCard[] => Object.values(state.cards).sort((a, b) => a.id - b.id);
