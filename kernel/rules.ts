// What the kernel reads in rules: their shape and which events a rule takes. The rules file is checked before it gets
// here, in protocol/rules.ts.
export type Access = "read" | "edit" | "full";
export type Source = { name: string; adapter?: string };
type AgentOptions = {
  model?: string;
  effort?: string;
  tier?: string;
  command?: string[];
  program?: string;
  timeout?: number;
};
export type Agent = AgentOptions & { name: string; worker: string; use: string; access: Access; maxActive?: number };
export type Channel = { name: string; answerers?: string[]; links?: boolean };
/** A registered project: its rules, its working directory and its archive. `archive` names where the archive lives when
 * it isn't the hub's own store; the dispatch itself decides the address a worker is given. */
export type Project = { name: string; cwd: string; archive?: string };
export type Tell = "always" | "needed" | "never";
/** A person's identities across channels, keyed by what the channel calls them. */
export type Person = Record<string, string>;
/** How the instruction gate decides: which rule judges, the score lines, and what an unauthorized instruction gets. */
export type Gate = {
  judge?: string;
  thresholds?: { pass: number; confirm: number };
  unauthorized?: "deny" | "confirm";
};
type EventFilter = { source: string; types: string[] };
type When = EventFilter | { cron: string };
type RuleWords = { skill?: string; prompt?: string };
/** A session's name for clients that take it from the first line: {subject} and {id} filled in by the worker. */
type RuleOptions = RuleWords & {
  title?: string;
  parallel?: number;
  maxActive?: number;
  resume?: boolean;
  emits?: EventFilter;
  /** The project this rule belongs to: its runs read the project's archive first and write back when done. */
  project?: string;
  /** With gate the rule's events wait for the instruction gate before a run is made of them. */
  gate?: boolean;
};
/** Without channels a rule's cards reach the default ones, or every channel if there are none; with them, only those. */
type Reach = { channels?: string[] };
/** Without parallel a rule's group runs one at a time; with it, each subject is its own thread, that many at once. */
export type Rule = RuleOptions &
  Reach & { name: string; when: When; to: string; cwd: string; group: string; tell: Tell };
/** A scheduled task that runs elsewhere (say, in the Claude app): the hub neither starts nor records it. With a cwd it can
 * also ask, and your answer goes on there like a round of a rule. */
export type Elsewhere = RuleWords & {
  name: string;
  source: string;
  to: string;
  cron: string;
  where: string;
  /** What its app runs it on, only to be shown: the hub starts nothing with them. */
  model?: string;
  effort?: string;
  cwd?: string;
};
type Registered = {
  sources: Record<string, Source>;
  agents: Record<string, Agent>;
  channels: Record<string, Channel>;
  projects?: Record<string, Project>;
};
/** The role catalog as the shell hands it in: each role an ordered chain of candidates. `device`, `model` and `when`
 * are for people to read; dispatch looks the candidate's agent up in the rules and takes its worker and model there. */
export type CatalogCandidate = { agent: string; device?: string; model?: string; when?: string };
export type Catalog = { roles: Record<string, CatalogCandidate[]>; version?: number; generatedAt?: string };
/** A rule's `to` naming `role:<角色>` says dispatch walks that role's chain instead of one fixed agent. */
export const ROLE_PREFIX = "role:";
export type Rules = Registered & {
  timezone: string;
  askFirst: string[];
  /** Who is who across channels: a person's name for their identity on each channel. */
  people?: Record<string, Person>;
  gate?: Gate;
  /** Where a card that names no channels of its own goes: a tell, the hub's own alerts, a rule without a list. */
  defaultChannels?: string[];
  rules: Rule[];
  elsewhere: Elsewhere[];
};

/** The source of what the clock makes happen. */
export const SCHEDULE = "schedule";

function typeMatch(pattern: string, type: string) {
  return pattern === "*" || pattern === type || (pattern.endsWith(".*") && type.startsWith(pattern.slice(0, -1)));
}
export const typeMatches = (patterns: string[], type: string) => patterns.some((pattern) => typeMatch(pattern, type));
export const eventRule = (rule: Rule): rule is Rule & { when: EventFilter } => "source" in rule.when;
export const cronOf = (rule: Rule) => (rule.when as { cron: string }).cron;

/** The person an identity belongs to, per the rules' people table, or none. */
export function personOf(rules: Rules, identity: string): string | undefined {
  if (!identity) return undefined;
  for (const [person, ids] of Object.entries(rules.people ?? {})) {
    if (Object.values(ids).includes(identity)) return person;
  }
  return undefined;
}

/**
 * The identities a channel's answerers stand for: a person name expands through `people`, a raw identity stays
 * itself, so the old answerers style keeps working. The person name stays in the set too, so an answer may also be
 * checked as the person rather than a device identity.
 */
export function answererIds(rules: Rules, channel: string): Set<string> {
  const ids = new Set<string>();
  for (const entry of rules.channels[channel]?.answerers ?? []) {
    ids.add(entry);
    for (const identity of Object.values(rules.people?.[entry] ?? {})) ids.add(identity);
  }
  return ids;
}

/** The rule a run, card or timer names: a rule's own, or a task elsewhere's, which only your answers to it start. */
export function ruleOf(rules: Rules, name: string): Rule | undefined {
  const rule = rules.rules.find((rule) => rule.name === name);
  if (rule) return rule;
  const task = rules.elsewhere.find((task) => task.name === name);
  if (!task?.cwd) return undefined;
  const { source, to, cwd, skill, prompt } = task;
  // No event type matches none: nothing that comes in starts it.
  return { name, when: { source, types: [] }, to, cwd, skill, prompt, group: name, tell: "needed" };
}
