// Project registration in rules.json: a project is a set of rules, a working directory and an archive. Failure cases:
// a rule naming a project that was never registered silently doing nothing about archives; a project entry missing its
// name or folder, carrying a misspelt field, or using an id the archive path can't hold; dispatch changing for rules
// that name no project.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

setup("projects");
const { parseRules: check, RulesError } = await import("../protocol/rules.ts");
const parseRules = (json: string) => check(json, Date.now(), "Asia/Shanghai");

const good = () => JSON.parse(readFileSync(join(import.meta.dirname, "rules.fixture.json"), "utf8"));
const withProjects = (change: (r: any) => void = () => {}) => {
  const r = good();
  r.projects = { "ai-loop": { name: "AI Loop", cwd: "~/code/ai-loop" } };
  r.rules[0].project = "ai-loop";
  change(r);
  return r;
};
const problem = (change: (r: any) => void, words: RegExp) => {
  assert.throws(
    () => parseRules(JSON.stringify(withProjects(change))),
    (error: Error) => {
      assert.ok(error instanceof RulesError);
      assert.match(error.message, words);
      return true;
    },
  );
};

test("a registered project and a rule naming it pass, keeping the fields through", () => {
  const rules = parseRules(JSON.stringify(withProjects()));
  assert.equal(rules.projects!["ai-loop"].name, "AI Loop");
  assert.equal(rules.projects!["ai-loop"].cwd, "~/code/ai-loop");
  assert.equal(rules.rules[0].project, "ai-loop");
});

test("a rule naming a project that isn't registered is refused", () => {
  problem((r) => {
    r.rules[0].project = "nowhere";
  }, /规则「意见」.*project.*nowhere/);
  problem((r) => {
    delete r.projects;
  }, /规则「意见」.*project/);
});

test("a project without a name or a folder, or with a field nobody knows, is refused", () => {
  problem((r) => {
    delete r.projects["ai-loop"].name;
  }, /项目 ai-loop.*name/);
  problem((r) => {
    delete r.projects["ai-loop"].cwd;
  }, /项目 ai-loop.*cwd/);
  problem((r) => {
    r.projects["ai-loop"].cwd = "relative/dir";
  }, /项目 ai-loop.*cwd/);
  problem((r) => {
    r.projects["ai-loop"].archive = 42;
  }, /项目 ai-loop.*archive/);
  problem((r) => {
    r.projects["ai-loop"].oops = 1;
  }, /项目 ai-loop 有不认识的字段 oops/);
  problem((r) => {
    r.projects["Bad Id"] = { name: "x", cwd: "~/x" };
  }, /项目的编号/);
});

test("rules without a project keep working; a project may carry an archive address", () => {
  const r = good();
  r.projects = { web: { name: "网站", cwd: "~/web", archive: "archive/web" } };
  const rules = parseRules(JSON.stringify(r));
  assert.equal(rules.projects!.web.archive, "archive/web");
  assert.equal(rules.rules[0].project, undefined);
});
