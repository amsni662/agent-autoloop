// Pushing an archive to an S3-compatible bucket and pulling a read-only copy back. Failure cases: the signature being
// wrong so a real bucket would refuse every request (checked against AWS's own published vector); a pushed object the
// bucket never receives; a pull that doesn't reproduce the archive; stale remote objects surviving a push so a later
// pull reads ghosts; listing pagination losing keys (.git alone has many objects); a request without credentials or
// with a wrong one being accepted; environment variables silently missing.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { setup } from "./helpers.ts";
import type { S3Config } from "../archive/s3.ts";

const home = setup("archive-sync");
const s3 = await import("../archive/s3.ts");
const sync = await import("../archive/sync.ts");
const store = await import("../archive/store.ts");

// AWS's own published get-vanilla vector: the signature this exact request must produce. If our SigV4 implementation
// computes it, real buckets accept what we send; the fake below only catches how requests are put together.
test("SigV4 produces AWS's documented signature for the get-vanilla request", () => {
  const signature = s3.signatureFor(
    {
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      service: "service",
    },
    {
      method: "GET",
      path: "/",
      query: [],
      headers: { host: "example.amazonaws.com" },
      body: Buffer.alloc(0),
      amzDate: "20150830T123600Z",
    },
  );
  assert.equal(signature.value, "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  assert.equal(signature.signedHeaders, "host;x-amz-date");
});

const KEY = { accessKeyId: "localtest", secretAccessKey: "localsecret" };

async function serveBucket(): Promise<{ cfg: S3Config; objects: Map<string, Buffer>; close: () => void }> {
  const objects = new Map<string, Buffer>();
  const verify = (req: import("node:http").IncomingMessage, body: Buffer) =>
    s3.verifySignature(req, body, KEY.secretAccessKey);
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    await once(req, "end");
    const body = Buffer.concat(chunks);
    const refused = verify(req, body);
    if (refused) {
      res.writeHead(403, { "content-type": "application/xml" });
      res.end(`<Error><Code>${refused}</Code></Error>`);
      return;
    }
    const url = new URL(req.url!, "http://fake");
    const key = decodeURIComponent(url.pathname.replace(/^\/grok-bot-files\/?/, ""));
    if (req.method === "PUT") {
      objects.set(key, body);
      res.writeHead(200, { etag: `"${createHash("md5").update(body).digest("hex")}"` }).end();
    } else if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const startAfter = url.searchParams.get("continuation-token") ?? "";
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const page = keys.filter((k) => k > startAfter).slice(0, 5);
      const next = keys.filter((k) => k > startAfter).length > 5 ? page.at(-1)! : "";
      const contents = page
        .map(
          (k) =>
            `<Contents><Key>${k}</Key><ETag>"${createHash("md5").update(objects.get(k)!).digest("hex")}"</ETag><Size>${objects.get(k)!.length}</Size></Contents>`,
        )
        .join("");
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(
        `<ListBucketResult>${contents}<IsTruncated>${Boolean(next)}</IsTruncated>` +
          (next ? `<NextContinuationToken>${next}</NextContinuationToken>` : "") +
          `</ListBucketResult>`,
      );
    } else if (req.method === "GET" && objects.has(key)) {
      res.writeHead(200).end(objects.get(key));
    } else if (req.method === "GET") {
      res.writeHead(404, { "content-type": "application/xml" }).end("<Error><Code>NoSuchKey</Code></Error>");
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
  return {
    cfg: {
      endpoint: `http://127.0.0.1:${port}`,
      region: "auto",
      bucket: "grok-bot-files",
      ...KEY,
    },
    objects,
    close: () => server.close(),
  };
}

let bucket: Awaited<ReturnType<typeof serveBucket>>;
after(() => bucket?.close());

test("s3FromEnv says which variables are missing instead of sending unsigned requests", () => {
  assert.throws(() => s3.s3FromEnv({}), /ARCHIVE_S3_ENDPOINT|ARCHIVE_S3_ACCESS_KEY_ID/);
  const cfg = s3.s3FromEnv({
    ARCHIVE_S3_ENDPOINT: "https://example.r2.cloudflarestorage.com",
    ARCHIVE_S3_ACCESS_KEY_ID: "k",
    ARCHIVE_S3_SECRET_ACCESS_KEY: "s",
  });
  assert.equal(cfg.bucket, "grok-bot-files");
  assert.equal(cfg.region, "auto");
});

test("push mirrors the whole archive including .git; pull reproduces it and old versions still read", async () => {
  bucket ??= await serveBucket();
  const root = join(home, "archive");
  store.initArchive("app", { root });
  store.writeBack("app", { base: 0, log: ["第一轮"], status: "进行中。" }, { root });
  store.writeBack("app", { base: 1, log: ["第二轮"], status: "做完了。" }, { root });

  const pushed = await sync.pushArchive("app", { root, s3: bucket.cfg });
  assert.ok(pushed.sent > 5, `sent ${pushed.sent} objects`);
  const keys = [...bucket.objects.keys()];
  assert.ok(keys.includes("archive/app/档案.json"));
  assert.ok(keys.includes("archive/app/状态.md"));
  assert.ok(
    keys.some((k) => k.startsWith("archive/app/.git/")),
    "the repository itself goes up",
  );
  assert.ok(
    keys.some((k) => k.includes("/refs/tags/v2") || k.includes("v2")),
    "version tags go up",
  );

  const again = await sync.pushArchive("app", { root, s3: bucket.cfg });
  assert.equal(again.sent, 0, "unchanged objects are not re-sent");

  // A stray object from an older layout must not survive the mirror.
  bucket.objects.set("archive/app/旧文件.md", Buffer.from("stale"));
  const pruned = await sync.pushArchive("app", { root, s3: bucket.cfg });
  assert.equal(pruned.removed, 1);
  assert.ok(!bucket.objects.has("archive/app/旧文件.md"));

  const to = mkdtempSync(join(tmpdir(), "agent-autoloop-pulled-"));
  after(() => rmSync(to, { recursive: true, force: true }));
  const pulled = await sync.pullArchive("app", to, { s3: bucket.cfg });
  assert.equal(pulled.version, 2);
  const v2 = store.readArchive("app", to);
  assert.match(v2.status, /做完了/);
  const v1 = store.readArchiveAt("app", 1, to);
  assert.match(v1.status, /进行中。/, "the pulled .git still serves old versions");
});

test("a pull clears local files the bucket no longer holds", async () => {
  bucket ??= await serveBucket();
  const to = mkdtempSync(join(tmpdir(), "agent-autoloop-pulled-stale-"));
  after(() => rmSync(to, { recursive: true, force: true }));
  mkdirSync(join(to, "app"), { recursive: true });
  writeFileSync(join(to, "app", "幽灵.md"), "本地多出来的");
  await sync.pullArchive("app", to, { s3: bucket.cfg });
  assert.equal(existsSync(join(to, "app", "幽灵.md")), false);
  assert.ok(existsSync(join(to, "app", "档案.json")));
});

test("a wrongly signed request is refused", async () => {
  bucket ??= await serveBucket();
  const bad = { ...bucket.cfg, secretAccessKey: "not-the-secret" };
  await assert.rejects(
    () => s3.listObjects(bad, "archive/"),
    (error: Error) => {
      assert.match(error.message, /403|SignatureDoesNotMatch| refused|签名/);
      return true;
    },
  );
});

test("pulling a project the bucket has none of is an error, not an empty directory", async () => {
  bucket ??= await serveBucket();
  const to = mkdtempSync(join(tmpdir(), "agent-autoloop-pulled-none-"));
  after(() => rmSync(to, { recursive: true, force: true }));
  await assert.rejects(() => sync.pullArchive("nosuch", to, { s3: bucket.cfg }), /没有|不存在/);
});
