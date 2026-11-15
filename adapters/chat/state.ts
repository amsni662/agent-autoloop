// Per-adapter state: the platform cursor, the reply credential, the current project and the index of cards waiting
// for an answer. It holds secrets (context_token), so it's always written 0600 and atomically.
import { chmodSync, existsSync, mkdirSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const SEEN_CAP = 500;
export const NOTIFIED_CAP = 500;
export const SUPPRESSED_CAP = 100;

export type PendingCard = {
  id: number;
  /** The ref the hub checks answers against: the clientId of the first delivery we reported. */
  ref: string;
  options: number;
  kind: string;
  title: string;
  recommend: number | null;
};

/** A card the message policy chose not to push: kept so the suppression is auditable, not silent. */
export type SuppressedEntry = { what: string; why: string; at: string };

export type ChatState = {
  currentProject: string | null;
  seen: string[];
  cursor?: string;
  contextToken?: string | null;
  /** When the newest context_token was captured — its age is what the platform measures. */
  contextTokenAt?: string;
  /** card:<id> → last version pushed to the owner: the idempotency key for outbound notifications. */
  notified?: Record<string, { version: number; at: string }>;
  /** Ring of policy-suppressed outbound items (cards and replies), newest last. */
  suppressed?: SuppressedEntry[];
  cards: Record<string, PendingCard>;
};

const fresh = (): ChatState => ({ currentProject: null, seen: [], notified: {}, suppressed: [], cards: {} });

export function loadState(file: string): ChatState {
  if (!existsSync(file)) return fresh();
  try {
    const state = JSON.parse(readFileSync(file, "utf8")) as ChatState;
    state.seen ??= [];
    state.cards ??= {};
    state.currentProject ??= null;
    state.notified ??= {};
    state.suppressed ??= [];
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

/** True when this card at this version already went out — the idempotency check for card pushes. */
export function alreadyNotified(state: ChatState, card: number, version: number): boolean {
  const hit = state.notified?.[`card:${card}`];
  return !!hit && hit.version >= version;
}

/** Called right after the platform takes the text — before the hub ack, so a crash can't send it twice. */
export function markNotified(state: ChatState, card: number, version: number): void {
  state.notified ??= {};
  state.notified[`card:${card}`] = { version, at: new Date().toISOString() };
  const keys = Object.keys(state.notified);
  if (keys.length > NOTIFIED_CAP) {
    keys
      .map((key) => [key, state.notified![key].at] as const)
      .sort((a, b) => a[1].localeCompare(b[1]))
      .slice(0, keys.length - NOTIFIED_CAP)
      .forEach(([key]) => delete state.notified![key]);
  }
}

/** An outbound item the policy held back — the audit trail for "不推送也要留痕". */
export function recordSuppressed(state: ChatState, what: string, why: string): void {
  state.suppressed ??= [];
  state.suppressed.push({ what, why, at: new Date().toISOString() });
  if (state.suppressed.length > SUPPRESSED_CAP) state.suppressed.splice(0, state.suppressed.length - SUPPRESSED_CAP);
}
