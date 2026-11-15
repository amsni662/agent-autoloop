// Failure cases: a push interrupted mid-upload moving the pointer so readers pull a half version; a pull that died
// mid-download leaving a torn local copy; pulling a version the bucket never published; the pointer naming a version
// whose objects aren't all there.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { setup } from "./helpers.ts";
import type { S3Config } from "../archive/s3.ts";

const home = setup("archive-publish");
const s3 = await import("../archive/s3.ts");
const sync = await import("../archive/sync.ts");
const store = await import("../archive/store.ts");

const KEY = { accessKeyId: "localtest", secretAccessKey: "localsecret" };

async function serveBucket(fail: { puts?: number; gets?: number } = {}, objects = new Map<string, Buffer>()) {
  let puts = 0,
    gets = 0;
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    await once(req, "end");
    const body = Buffer.concat(chunks);
    const refused = s3.verifySignature(req, body, KEY.secretAccessKey);
    if (refused) {
      res.writeHead(403).end(`<Error><Code>${refused}</Code></Error>`);
      return;
    }
    const url = new URL(req.url!, "http://fake");
    const key = decodeURIComponent(url.pathname.replace(/^\/b\/?/, ""));
    if (req.method === "PUT") {
      if (++puts > (fail.puts ?? Infinity)) {
        res.writeHead(500).end("<Error><Code>InternalError</Code></Error>");
        return;
      }
      objects.set(key, body);
      res.writeHead(200, { etag: `"${createHash("md5").update(body).digest("hex")}"` }).end();
    } else if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const startAfter = url.searchParams.get("continuation-token") ?? "";
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const page = keys.filter((k) => k > startAfter).slice(0, 50);
      const next = keys.filter((k) => k > startAfter).length > 50 ? page.at(-1)! : "";
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(
        `<ListBucketResult>${page
          .map(
            (k) =>
              `<Contents><Key>${k}</Key><ETag>"${createHash("md5").update(objects.get(k)!).digest("hex")}"</ETag><Size>${objects.get(k)!.length}</Size></Contents>`,
          )
          .join("")}<IsTruncated>${Boolean(next)}</IsTruncated>` +
          (next ? `<NextContinuationToken>${next}</NextContinuationToken>` : "") +
          `</ListBucketResult>`,
      );
    } else if (req.method === "GET") {
      if (++gets > (fail.gets ?? Infinity)) {
        res.writeHead(500).end("<Error><Code>InternalError</Code></Error>");
        return;
      }
      if (objects.has(key)) res.writeHead(200).end(objects.get(key));
      else res.writeHead(404).end("<Error><Code>NoSuchKey</Code></Error>");
    } else if (req.method === "DELETE") {
      objects.delete(key);
      res.writeHead(204).end();
    } else {
      res.writeHead(400).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  const cfg: S3Config = {
    endpoint: `http://127.0.0.1:${port}`,
    region: "auto",
    bucket: "b",
    prefix: "",
    ...KEY,
  };
  return { cfg, objects, close: () => server.close() };
}

const open: { close: () => void }[] = [];
after(() => open.forEach((server) => server.close()));

test("an interrupted upload leaves the pointer where it was, then a retry publishes whole", async () => {
  const root = join(home, "archive");
  store.initArchive("proj", { root });
  store.writeBack("proj", { base: 0, log: ["第一轮"], status: "起步。" }, { root });

  const dying = await serveBucket({ puts: 3 }); // dies on the 4th PUT: part of v1 lands, the pointer never does
  open.push(dying);
  await assert.rejects(() => sync.pushArchive("proj", { root, s3: dying.cfg }));
  assert.equal(dying.objects.has("archive/proj/current.json"), false, "the pointer never moved");
  assert.ok(
    [...dying.objects.keys()].some((key) => key.startsWith("archive/proj/v1/")),
    "part of the version can be up — it just stays inert",
  );

  const well = await serveBucket({}, dying.objects);
  open.push(well);
  const pushed = await sync.pushArchive("proj", { root, s3: well.cfg });
  assert.equal(pushed.version, 1);
  const pointer = JSON.parse(well.objects.get("archive/proj/current.json")!.toString("utf8"));
  assert.equal(pointer.version, 1);
  const remote = [...well.objects.keys()].filter((key) => key.startsWith("archive/proj/v1/"));
  for (const file of ["档案.json", "状态.md", "日志.md", "决定.md", "说明书.md"]) {
    assert.ok(remote.includes(`archive/proj/v1/${file}`), `${file} published`);
  }

  const to = mkdtempSync(join(tmpdir(), "agent-autoloop-pulled-v-"));
  after(() => rmSync(to, { recursive: true, force: true }));
  const pulled = await sync.pullArchive("proj", to, { s3: well.cfg });
  assert.equal(pulled.version, 1);
  assert.match(store.readArchive("proj", to).status, /起步/);
});

test("a pull interrupted mid-download leaves no local copy at all", async () => {
  const root = join(home, "archive");
  store.writeBack("proj", { base: 1, log: ["第二轮"], status: "又进一步。" }, { root });
  const well = await serveBucket();
  open.push(well);
  await sync.pushArchive("proj", { root, s3: well.cfg });

  // Downloads die on the second object GET: the staging copy must be cleaned, the local dir must not appear.
  const dying = await serveBucket({ gets: 2 }, well.objects);
  open.push(dying);
  const to = mkdtempSync(join(tmpdir(), "agent-autoloop-torn-"));
  after(() => rmSync(to, { recursive: true, force: true }));
  await assert.rejects(() => sync.pullArchive("proj", to, { s3: dying.cfg }));
  assert.equal(existsSync(join(to, "proj")), false, "no half-pulled copy is left in place");
  assert.equal(
    readdirSync(to).filter((name) => name.startsWith("proj")).length,
    0,
    "the staging directory is cleaned too",
  );

  // A pointer naming a version that was never fully pushed can't be pulled either.
  dying.objects.set("archive/proj/current.json", Buffer.from('{"project":"proj","version":9,"head":"x","at":"t"}'));
  await assert.rejects(() => sync.pullArchive("proj", to, { s3: well.cfg }), /v9/);
});
