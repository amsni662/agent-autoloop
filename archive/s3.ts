// An S3-compatible client with nothing but node:crypto: AWS SigV4 signing implemented here (service "s3"), path-style
// URLs (<endpoint>/<bucket>/<key>) which Cloudflare R2 and local stand-ins both accept. Credentials come only from the
// environment; they are never logged, written to the archive or committed anywhere.
import { createHash, createHmac, type BinaryLike } from "node:crypto";

export type S3Config = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export class S3Error extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function s3FromEnv(env: NodeJS.ProcessEnv = process.env): S3Config {
  const missing = ["ARCHIVE_S3_ENDPOINT", "ARCHIVE_S3_ACCESS_KEY_ID", "ARCHIVE_S3_SECRET_ACCESS_KEY"].filter(
    (name) => !env[name],
  );
  if (missing.length) {
    throw new S3Error(0, `缺环境变量 ${missing.join("、")}：把私密桶凭据写进 secrets.env 或环境，不要写进文件`);
  }
  return {
    endpoint: env.ARCHIVE_S3_ENDPOINT!.replace(/\/+$/, ""),
    region: env.ARCHIVE_S3_REGION || "auto",
    bucket: env.ARCHIVE_S3_BUCKET || "grok-bot-files",
    accessKeyId: env.ARCHIVE_S3_ACCESS_KEY_ID!,
    secretAccessKey: env.ARCHIVE_S3_SECRET_ACCESS_KEY!,
  };
}

// RFC 3986 unreserved characters stay; everything else becomes uppercase percent escapes, slash included.
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;
const enc = (text: string) =>
  [...Buffer.from(text, "utf8")]
    .map((byte) =>
      UNRESERVED.test(String.fromCharCode(byte))
        ? String.fromCharCode(byte)
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`,
    )
    .join("");
const encodePath = (path: string) => path.split("/").map(enc).join("/");
const sha256 = (body: string | Buffer) => createHash("sha256").update(body).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

export type SignInput = {
  method: string;
  path: string;
  query: [string, string][];
  headers: Record<string, string>;
  body: Buffer;
  amzDate?: string;
};

export type Signed = {
  value: string;
  signedHeaders: string;
  authorization: string;
  canonicalPath: string;
  canonicalQuery: string;
  payloadHash: string;
  amzDate: string;
};

/** The signature a request must carry, plus the canonical path and query to actually send so they match what was signed. */
export function signatureFor(
  cfg: Pick<S3Config, "accessKeyId" | "secretAccessKey" | "region"> & { service?: string },
  input: SignInput,
): Signed {
  const service = cfg.service ?? "s3";
  const amzDate =
    input.amzDate ??
    new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${cfg.region}/${service}/aws4_request`;
  const payloadHash = sha256(input.body);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers)) headers[name.toLowerCase()] = value;
  headers["x-amz-date"] = amzDate;
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${headers[name].trim().replace(/ +/g, " ")}\n`)
    .join("");
  const canonicalPath = encodePath(input.path);
  const canonicalQuery = input.query
    .map(([key, value]) => [enc(key), enc(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const canonical = [input.method, canonicalPath, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join(
    "\n",
  );
  const toSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonical)}`;
  const key = [cfg.region, service, "aws4_request"].reduce(
    (k, part) => hmac(k, part),
    hmac(`AWS4${cfg.secretAccessKey}`, dateStamp),
  );
  const value = createHmac("sha256", key).update(toSign).digest("hex");
  return {
    value,
    signedHeaders,
    authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${value}`,
    canonicalPath,
    canonicalQuery,
    payloadHash,
    amzDate,
  };
}

/** What a bucket side can check a request against: null when the signature is right, an S3-style code otherwise. */
export function verifySignature(
  req: { method?: string; url?: string; headers: Record<string, string | string[] | undefined> },
  body: Buffer,
  secretAccessKey: string,
): string | null {
  const auth = String(req.headers.authorization ?? "");
  const found =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(
      auth,
    );
  if (!found) return "MalformedAuthorization";
  const [, accessKeyId, , region, signedList, given] = found;
  const url = new URL(req.url ?? "/", "http://bucket.test");
  const headers: Record<string, string> = {};
  for (const name of signedList.split(";")) {
    const value = req.headers[name];
    if (value === undefined) return "SignatureDoesNotMatch";
    headers[name] = Array.isArray(value) ? value.join(",") : value;
  }
  const payloadHash = sha256(body);
  if (req.headers["x-amz-content-sha256"] && req.headers["x-amz-content-sha256"] !== payloadHash) {
    return "XAmzContentSHA256Mismatch";
  }
  const signed = signatureFor(
    { accessKeyId, secretAccessKey, region },
    {
      method: req.method ?? "GET",
      path: decodeURIComponent(url.pathname),
      query: [...url.searchParams.entries()],
      headers,
      body,
      amzDate: String(req.headers["x-amz-date"] ?? ""),
    },
  );
  return signed.value === given ? null : "SignatureDoesNotMatch";
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const unescapeXml = (text: string) => text.replace(/&(lt|gt|amp|quot|apos);/g, (_, e) => ENTITIES[e]);
const xmlTag = (xml: string, tag: string) =>
  unescapeXml(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1] ?? "");

async function request(
  cfg: S3Config,
  method: string,
  key: string | null,
  options: { query?: [string, string][]; body?: Buffer } = {},
): Promise<Buffer> {
  const body = options.body ?? Buffer.alloc(0);
  const path = key === null ? `/${cfg.bucket}` : `/${cfg.bucket}/${key}`;
  const signed = signatureFor(cfg, {
    method,
    path,
    query: options.query ?? [],
    headers: { host: new URL(cfg.endpoint).host, "x-amz-content-sha256": sha256(body) },
    body,
  });
  const url = `${cfg.endpoint}${signed.canonicalPath}${signed.canonicalQuery ? `?${signed.canonicalQuery}` : ""}`;
  const res = await fetch(url, {
    method,
    headers: {
      authorization: signed.authorization,
      "x-amz-date": signed.amzDate,
      "x-amz-content-sha256": signed.payloadHash,
    },
    body: method === "GET" || method === "HEAD" ? undefined : new Uint8Array(body),
  });
  const data = Buffer.from(await res.arrayBuffer());
  if (res.status >= 400) {
    const text = data.toString("utf8");
    throw new S3Error(res.status, `桶拒绝了（${res.status}）：${xmlTag(text, "Code") || text.slice(0, 200)}`);
  }
  return data;
}

export type BucketObject = { key: string; etag: string; size: number };

export async function listObjects(cfg: S3Config, prefix: string): Promise<BucketObject[]> {
  const found: BucketObject[] = [];
  let token = "";
  do {
    const query: [string, string][] = [
      ["list-type", "2"],
      ["prefix", prefix],
    ];
    if (token) query.push(["continuation-token", token]);
    const xml = (await request(cfg, "GET", null, { query })).toString("utf8");
    for (const item of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      found.push({
        key: xmlTag(item[1], "Key"),
        etag: xmlTag(item[1], "ETag").replaceAll('"', ""),
        size: Number(xmlTag(item[1], "Size")),
      });
    }
    token = xmlTag(xml, "NextContinuationToken");
  } while (token);
  return found;
}

export const putObject = (cfg: S3Config, key: string, body: Buffer) => request(cfg, "PUT", key, { body });
export const deleteObject = (cfg: S3Config, key: string) => request(cfg, "DELETE", key);

export async function getObject(cfg: S3Config, key: string): Promise<Buffer | null> {
  try {
    return await request(cfg, "GET", key);
  } catch (error) {
    if (error instanceof S3Error && error.status === 404) return null;
    throw error;
  }
}
