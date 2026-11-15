// Failure case: the archive loop broken anywhere end to end — a job reaching the worker without the archive pointer,
// the agent not finding the archive where the context says, the receipt's write-back never landing in the archive on
// disk, the round still marked unfinished afterwards, or the read door not serving what landed.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { setup } from "./helpers.ts";
import { after } from "node:test";

const home = setup("archive-e2e");
// Its own rules: a project rule to a real command agent that reads the archive the context names and hands a
// write-back in its receipt, like a cooperative agent would.
const rulesPath = join(home, "rules.json");
writeFileSync(
  rulesPath,
  JSON.stringify({
    timezone: "Asia/Shanghai",
    sources: { app: { name: "应用" } },
    agents: {
      a1: {
        name: "甲",
        worker: "w1",
        use: "command",
        command: [
          process.execPath,
          "-e",
          `const fs=require("fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
           const v=(c.archive&&c.archive.version)||0;const p=c.archive&&c.archive.path;
           const read=p?fs.readFileSync(p+"/状态.md","utf8").trim():"没读到";
           console.log("做完了 读到 "+read);
           console.log("\`\`\`agent-autoloop");
           console.log(JSON.stringify({archive:{base:v,log:["e2e 一轮"],status:"e2e 状态整篇"}}));
           console.log("\`\`\`")`,
          "{context}",
        ],
      },
    },
    projects: { proj: { name: "测试项目", cwd: home, archive: "archives/proj" } },
    rules: [
      {
        name: "项目活",
        when: { source: "app", types: ["work.*"] },
        to: "a1",
        cwd: home,
        prompt: "干活",
        project: "proj",
      },
    ],
  }),
);
process.env.AGENT_AUTOLOOP_RULES = rulesPath;

const { serve } = await import("../host/http.ts");
const hub = await import("./hub.ts");
const { hubClient } = await import("../protocol/client.ts");
const { createWorker } = await import("../worker/worker.ts");
const store = await import("../archive/store.ts");
const { rows } = await import("../kernel/evolve.ts");

const keys = { app: hub.addKey("source", "app"), w1: hub.addKey("worker", "w1") };
const server = serve(0, "127.0.0.1", { commit: "test" });
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
  server.closeAllConnections();
  server.close();
});
const root = join(home, "archive");

async function until(done: () => boolean, what: string) {
  const end = Date.now() + 15_000;
  while (!done()) {
    if (Date.now() > end) assert.fail(`timed out waiting: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

test("event → job with archive → agent reads it → receipt writes back → the door serves the new version", async () => {
  store.initArchive("proj", { root, status: "建档状态" });
  store.writeBack("proj", { base: 0, status: "写回前的状态" }, { root });
  assert.equal(store.readArchive("proj", root).version, 1);

  const client = hubClient(base, keys.app);
  await client.event({ id: "e2e-1", type: "work.thing", subject: "#1" });
  const worker = createWorker({ hub: hubClient(base, keys.w1), name: "w1", wait: 0 });
  let stopped = false;
  const ticking = (async () => {
    const end = Date.now() + 15_000;
    while (!stopped && Date.now() < end) {
      await worker.tick().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })();

  const run = () => rows(hub.getView(), "runs").find((r) => r.state === "done");
  await until(() => run()?.archive === "written", "run finished and written back");

  // Two writes for one round: the receipt's payload is one version, the automatic log line the next.
  const archive = store.readArchive("proj", root);
  assert.equal(archive.version, 3);
  assert.equal(archive.status.trim(), "e2e 状态整篇");
  assert.equal(archive.log.includes("e2e 一轮"), true);
  assert.equal(archive.log.includes("「项目活」"), true, "the automatic log line went in too");

  const served = (await hubClient(base, keys.w1).archive("proj", 3)) as any;
  assert.equal(served.version, 3);
  assert.equal(served.status.trim(), "e2e 状态整篇");
  const earlier = (await hubClient(base, keys.w1).archive("proj", 2)) as any;
  assert.equal(earlier.version, 2);
  const current = (await hubClient(base, keys.w1).archive("proj")) as any;
  assert.equal(current.version, 3);

  const row = hub.getView().get("archives", "proj")!;
  assert.equal(row.version, 3);
  assert.equal(row.commit, archive.commit);
  stopped = true;
  await ticking;
});
