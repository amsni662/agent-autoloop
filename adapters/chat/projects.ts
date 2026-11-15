// Projects come from the hub's rules.json `projects` block — that's the registry of what exists. Message text can
// pick one of them; it can never change what the rule decided about agent, cwd or access.
import { readFileSync } from "node:fs";

export type Project = { id: string; name: string };

export function loadProjects(rulesFile: string): Project[] {
  const rules = JSON.parse(readFileSync(rulesFile, "utf8")) as {
    projects?: Record<string, { name?: string }>;
  };
  return Object.entries(rules.projects ?? {}).map(([id, project]) => ({
    id,
    name: project.name ?? id,
  }));
}

/** Spaces and case don't count: "AI Loop", "ai-loop" and "ailoop " all name the same project. */
const normalize = (text: string) => text.replace(/\s+/g, "").toLowerCase();

export function resolveProject(name: string, projects: Project[]): string | null {
  const wanted = normalize(name);
  const found = projects.find((project) => normalize(project.id) === wanted || normalize(project.name) === wanted);
  return found?.id ?? null;
}

export function describeProjects(projects: Project[], current: string | null): string {
  const lines = projects.map(
    (project) => `- ${project.name}（${project.id}）${project.id === current ? " ← 当前" : ""}`,
  );
  return `已登记的项目：\n${lines.join("\n")}`;
}
