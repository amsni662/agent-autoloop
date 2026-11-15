// 这个文件守着凭据脱敏。防的失败方式：回执 raw/error 里的令牌、Bearer、私钥、API key 没脱敏
// 就进了投影、卡片和档案；老接单程序送来没脱敏的 diagnosis；过度脱敏把正常文字弄坏。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setup } from "./helpers.ts";

setup("redact");
const { redact } = await import("../protocol/redact.ts");
const { diagnose } = await import("../worker/diagnose.ts");
const { decide } = await import("../kernel/decide.ts");
const { empty, evolve, rows } = await import("../kernel/evolve.ts");
const { parseRules } = await import("../protocol/rules.ts");

const environment = { secret: "redact-secret", publicUrl: "https://hub.test" };
const rules = parseRules(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"), 0, "UTC");

function hub() {
  let v = evolve(empty(), decide(empty(), { type: "rules", args: [rules] }, 1, environment).facts);
  return {
    act: (type: string, args: unknown[], now: number) => {
      const d = decide(v, { type, args }, now, environment);
      v = evolve(v, d.facts);
      return d.value;
    },
    get view() {
      return v;
    },
  };
}

test("令牌、私钥、授权头被换掉", () => {
  const cases: [string, string][] = [
    ["Authorization: Bearer abc.def.ghi\nnext", "[已脱敏]\nnext"],
    ["bearer tok-12345678 done", "Bearer [已脱敏] done"],
    ["BEARER tok-12345678 done", "Bearer [已脱敏] done"],
    ["key = sk-abc123XYZ_-长一点的尾巴", "key = [已脱敏]"],
    ["GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456", "GITHUB_TOKEN=[已脱敏]"],
    ["api_key: 0123456789abcdef0123456789abcdef", "api_key: [已脱敏]"],
    ["apikey=zz0-secret-9", "apikey=[已脱敏]"],
    ["mysecret: hunter2xyz", "mysecret: [已脱敏]"],
    ["passwd=w0rdpass88", "passwd=[已脱敏]"],
    ["api.key=0123456789abcdef", "api.key=[已脱敏]"],
    ["context_token=eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiYSJ9.signature-part", "context_token=[已脱敏]"],
    ["https://user:p4ssw0rd@example.com/x", "https://[已脱敏]@example.com/x"],
    ["-----BEGIN OPENSSH PRIVATE KEY-----\nabc123\n-----END OPENSSH PRIVATE KEY-----", "[已脱敏的私钥]"],
    ["xoxb-1234567890-abcdefghijkl", "[已脱敏]"],
    ["AKIAIOSFODNN7EXAMPLE", "[已脱敏]"],
  ];
  for (const [input, expected] of cases) assert.equal(redact(input), expected, input);
});

test("正常文字原样保留", () => {
  const plain =
    "第 3 步失败：rate limit exceeded，retry after 60s；token 这个词单独出现不算凭据。" +
    "monkey=bananas1、keyboard=qwertyui、hotkey=ctrlshift9 也不是凭据。";
  assert.equal(redact(plain), plain);
});

test("diagnose 生成 raw 时脱敏", () => {
  const d = diagnose({
    outcome: "failed",
    stderr: "HTTP 401 Authorization: Bearer sekrit-token-123456789",
    code: 1,
    device: "w1",
    agent: "a1",
    model: "m1",
    output: "/tmp/run",
  });
  assert.ok(d.raw?.includes("[已脱敏]"), d.raw ?? "");
  assert.ok(!d.raw?.includes("sekrit-token"), d.raw ?? "");
});

test("finish 入口对老接单程序的回执再脱一遍", () => {
  const h = hub();
  h.act("ingest", ["app", { id: "e1", type: "feedback.new", subject: "s", summary: "事" }], 1);
  const job = h.act("claimNext", ["w1", "c1"], 2);
  const result = h.act(
    "finish",
    [
      job.run,
      job.token,
      {
        outcome: "failed",
        diagnosis: {
          category: "need_login",
          explain: "401 with Bearer tok-secret-123456",
          device: "w1",
          agent: "a1",
          raw: "Authorization: Bearer tok-secret-123456",
          output: "/r",
        },
      },
    ],
    3,
  );
  assert.deepEqual(result.rejected, []);
  const run = rows(h.view, "runs", { id: job.run })[0];
  const stored = JSON.parse(run.diagnosis);
  assert.ok(!stored.raw.includes("tok-secret"), stored.raw);
  assert.ok(!stored.explain.includes("tok-secret"), stored.explain);
  const card = rows(h.view, "cards", { state: "open" })[0];
  assert.ok(!card.text.includes("tok-secret"), card.text);
  assert.ok(card.text.includes("[已脱敏]"), card.text);
});

test("summary 和通知、提问的正文进库前也脱敏", () => {
  const h = hub();
  h.act("ingest", ["app", { id: "e1", type: "feedback.new", subject: "s", summary: "事" }], 1);
  const job = h.act("claimNext", ["w1", "c1"], 2);
  h.act(
    "finish",
    [
      job.run,
      job.token,
      {
        outcome: "done",
        summary: "做完了，但 apikey=sk-livesecret-9999 还在日志里",
        notice: [{ title: "注意", text: "BEARER tok-aaabbbccc111 别再发" }],
        ask: [
          {
            title: "选",
            text: "mysecret=hunter2xx 怎么办",
            options: ["重试", "算了"],
            about: "clientsecret: abcdef999",
          },
        ],
      },
    ],
    3,
  );
  const run = rows(h.view, "runs", { id: job.run })[0];
  assert.ok(!run.summary.includes("sk-livesecret"), run.summary);
  const blob = rows(h.view, "cards", {})
    .map((card) => [card.title, card.text, card.options, card.about].join("\n"))
    .join("\n");
  for (const leaked of ["tok-aaabbb", "hunter2xx", "abcdef999"]) {
    assert.ok(!blob.includes(leaked), `${leaked} in ${blob}`);
  }
});
