import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { uploadLimits } from "@/lib/uploadLimits";

const DEFAULT_BUCKET = "music-berg";

export type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Optional public/custom base (no trailing slash), e.g. https://audio.example.com */
  publicBaseUrl: string | null;
};

export function readR2Config(): R2Config | null {
  const accountId = process.env.R2_ACCOUNT_ID?.trim() ?? "";
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim() ?? "";
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim() ?? "";
  const bucket = process.env.R2_BUCKET?.trim() || DEFAULT_BUCKET;
  const publicBaseUrl =
    process.env.R2_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") || null;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    return null;
  }
  return { accountId, accessKeyId, secretAccessKey, bucket, publicBaseUrl };
}

/** True when server can read/write the configured R2 bucket. */
export function r2UploadsEnabled(): boolean {
  return readR2Config() != null;
}

let cachedClient: { key: string; client: S3Client } | undefined;

function r2Client(config: R2Config): S3Client {
  const key = `${config.accountId}:${config.accessKeyId}:${config.bucket}`;
  if (cachedClient?.key === key) return cachedClient.client;
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  cachedClient = { key, client };
  return client;
}

const R2_LOCATOR_PREFIX = "r2://";

/** Opaque durable locator: `r2://<bucket>/<key>`. */
export function toR2Locator(bucket: string, key: string): string {
  const cleanKey = key.replace(/^\/+/, "");
  return `${R2_LOCATOR_PREFIX}${bucket}/${cleanKey}`;
}

/** @deprecated Use toR2Locator — same format. */
export const toR2StagingUrl = toR2Locator;

export function parseR2Locator(
  url: string,
): { bucket: string; key: string } | null {
  const trimmed = url.trim();
  if (!trimmed.startsWith(R2_LOCATOR_PREFIX)) return null;
  const rest = trimmed.slice(R2_LOCATOR_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  const bucket = rest.slice(0, slash);
  const key = rest.slice(slash + 1).replace(/^\/+/, "");
  if (!bucket || !key) return null;
  return { bucket, key };
}

/** @deprecated Use parseR2Locator. */
export const parseR2StagingUrl = parseR2Locator;

export function isR2Locator(url: string): boolean {
  return parseR2Locator(url) != null;
}

/** @deprecated Use isR2Locator. */
export const isR2StagingUrl = isR2Locator;

/** Also accept public/custom-domain URLs under R2_PUBLIC_BASE_URL. */
export function parseR2PublicUrl(
  url: string,
  config: R2Config,
): { bucket: string; key: string } | null {
  if (!config.publicBaseUrl) return null;
  try {
    const base = new URL(config.publicBaseUrl);
    const u = new URL(url);
    if (u.origin !== base.origin) return null;
    const basePath = base.pathname.replace(/\/+$/, "");
    let path = u.pathname;
    if (basePath && path.startsWith(basePath)) {
      path = path.slice(basePath.length);
    }
    const key = path.replace(/^\/+/, "");
    if (!key) return null;
    return { bucket: config.bucket, key };
  } catch {
    return null;
  }
}

export function publicUrlForKey(config: R2Config, key: string): string | null {
  if (!config.publicBaseUrl) return null;
  const clean = key.replace(/^\/+/, "");
  return `${config.publicBaseUrl}/${clean}`;
}

export function resolveObjectRef(
  keyOrUrl: string,
  config: R2Config,
): { bucket: string; key: string } | null {
  const asLocator = parseR2Locator(keyOrUrl);
  if (asLocator) return asLocator;
  const asPublic = parseR2PublicUrl(keyOrUrl, config);
  if (asPublic) return asPublic;
  // Bare object key stored in DB
  const key = keyOrUrl.replace(/^\/+/, "").trim();
  if (!key || key.includes("://")) return null;
  return { bucket: config.bucket, key };
}

export async function createR2PresignedUpload(opts: {
  key: string;
  contentType: string;
  contentLength: number;
  expiresInSeconds?: number;
}): Promise<{
  uploadUrl: string;
  stagingUrl: string;
  objectUrl: string;
  key: string;
  bucket: string;
}> {
  const config = readR2Config();
  if (!config) throw new Error("R2 is not configured");
  if (
    !Number.isFinite(opts.contentLength) ||
    opts.contentLength <= 0 ||
    opts.contentLength > uploadLimits.maxFileBytes
  ) {
    throw new Error("Invalid upload size");
  }

  const key = opts.key.replace(/^\/+/, "");
  const client = r2Client(config);
  const command = new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    ContentType: opts.contentType,
    ContentLength: opts.contentLength,
  });
  const uploadUrl = await getSignedUrl(client, command, {
    expiresIn: opts.expiresInSeconds ?? 60 * 10,
  });
  const locator = toR2Locator(config.bucket, key);
  return {
    uploadUrl,
    stagingUrl: locator,
    objectUrl: publicUrlForKey(config, key) ?? locator,
    key,
    bucket: config.bucket,
  };
}

export async function createR2PresignedGet(
  key: string,
  opts: { expiresInSeconds?: number; responseContentType?: string } = {},
): Promise<string> {
  const config = readR2Config();
  if (!config) throw new Error("R2 is not configured");
  const client = r2Client(config);
  const command = new GetObjectCommand({
    Bucket: config.bucket,
    Key: key.replace(/^\/+/, ""),
    ResponseContentType: opts.responseContentType,
  });
  return getSignedUrl(client, command, {
    expiresIn: opts.expiresInSeconds ?? 120,
  });
}

async function streamToBuffer(
  body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | Blob | undefined,
  maxBytes: number,
): Promise<Buffer> {
  if (!body) throw new Error("Empty R2 object body");

  if (typeof Blob !== "undefined" && body instanceof Blob) {
    if (body.size > maxBytes) throw new Error("Audio object exceeds size limit");
    return Buffer.from(await body.arrayBuffer());
  }

  const chunks: Buffer[] = [];
  let total = 0;

  if (Symbol.asyncIterator in Object(body)) {
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      const buf = Buffer.from(chunk);
      total += buf.byteLength;
      if (total > maxBytes) throw new Error("Audio object exceeds size limit");
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  }

  const reader = (body as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) throw new Error("Audio object exceeds size limit");
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks);
}

export async function headR2Object(
  keyOrUrl: string,
): Promise<{ key: string; bucket: string; contentLength: number; contentType: string | null }> {
  const config = readR2Config();
  if (!config) throw new Error("R2 is not configured");
  const parsed = resolveObjectRef(keyOrUrl, config);
  if (!parsed) throw new Error("Invalid R2 object reference");
  if (parsed.bucket !== config.bucket) throw new Error("R2 bucket mismatch");

  const client = r2Client(config);
  const result = await client.send(
    new HeadObjectCommand({
      Bucket: parsed.bucket,
      Key: parsed.key,
    }),
  );
  const contentLength = Number(result.ContentLength ?? 0);
  if (!Number.isFinite(contentLength) || contentLength <= 0) {
    throw new Error("R2 object missing or empty");
  }
  if (contentLength > uploadLimits.maxFileBytes) {
    throw new Error("Audio object exceeds size limit");
  }
  return {
    key: parsed.key,
    bucket: parsed.bucket,
    contentLength,
    contentType: result.ContentType?.trim() || null,
  };
}

export async function fetchR2Audio(keyOrUrl: string): Promise<Buffer> {
  const config = readR2Config();
  if (!config) throw new Error("R2 is not configured");

  const parsed = resolveObjectRef(keyOrUrl, config);
  if (!parsed) throw new Error("Invalid R2 audio URL");
  if (parsed.bucket !== config.bucket) {
    throw new Error("R2 bucket mismatch");
  }

  const client = r2Client(config);
  const result = await client.send(
    new GetObjectCommand({
      Bucket: parsed.bucket,
      Key: parsed.key,
    }),
  );

  if (result.ContentLength != null && result.ContentLength > uploadLimits.maxFileBytes) {
    throw new Error("Audio object exceeds size limit");
  }

  return streamToBuffer(
    result.Body as AsyncIterable<Uint8Array> | undefined,
    uploadLimits.maxFileBytes,
  );
}

export async function getR2ObjectStream(keyOrUrl: string): Promise<{
  body: AsyncIterable<Uint8Array>;
  contentType: string | null;
  contentLength: number | null;
  key: string;
}> {
  const config = readR2Config();
  if (!config) throw new Error("R2 is not configured");
  const parsed = resolveObjectRef(keyOrUrl, config);
  if (!parsed) throw new Error("Invalid R2 audio URL");
  if (parsed.bucket !== config.bucket) throw new Error("R2 bucket mismatch");

  const client = r2Client(config);
  const result = await client.send(
    new GetObjectCommand({
      Bucket: parsed.bucket,
      Key: parsed.key,
    }),
  );
  if (!result.Body) throw new Error("Empty R2 object body");
  return {
    body: result.Body as AsyncIterable<Uint8Array>,
    contentType: result.ContentType?.trim() || null,
    contentLength:
      result.ContentLength != null ? Number(result.ContentLength) : null,
    key: parsed.key,
  };
}

export async function deleteR2Quiet(keyOrUrl: string): Promise<void> {
  try {
    const config = readR2Config();
    if (!config) return;
    const parsed = resolveObjectRef(keyOrUrl, config);
    if (!parsed || parsed.bucket !== config.bucket) return;
    const client = r2Client(config);
    await client.send(
      new DeleteObjectCommand({
        Bucket: parsed.bucket,
        Key: parsed.key,
      }),
    );
  } catch {
    // best-effort cleanup
  }
}

export async function putR2Object(opts: {
  key: string;
  body: Buffer;
  contentType: string;
}): Promise<{
  stagingUrl: string;
  objectUrl: string;
  key: string;
  bucket: string;
}> {
  const config = readR2Config();
  if (!config) throw new Error("R2 is not configured");
  const key = opts.key.replace(/^\/+/, "");
  const client = r2Client(config);
  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: opts.body,
      ContentType: opts.contentType,
      ContentLength: opts.body.byteLength,
    }),
  );
  const locator = toR2Locator(config.bucket, key);
  return {
    stagingUrl: locator,
    objectUrl: publicUrlForKey(config, key) ?? locator,
    key,
    bucket: config.bucket,
  };
}

export function durableSongKey(opts: {
  songId?: string;
  filename: string;
}): string {
  const safeBase = opts.filename
    .replace(/^songs\//, "")
    .replace(/^templates\//, "")
    .replace(/[^\w.\-/]+/g, "_")
    .slice(0, 160);
  const id =
    opts.songId ||
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return `songs/${id}-${safeBase}`.slice(0, 200);
}
