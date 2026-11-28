import {
  DeleteObjectCommand,
  GetObjectCommand,
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
  const bucket =
    process.env.R2_BUCKET?.trim() || DEFAULT_BUCKET;
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

const R2_STAGING_PREFIX = "r2://";

/** Opaque staging locator: `r2://<bucket>/<key>`. */
export function toR2StagingUrl(bucket: string, key: string): string {
  const cleanKey = key.replace(/^\/+/, "");
  return `${R2_STAGING_PREFIX}${bucket}/${cleanKey}`;
}

export function parseR2StagingUrl(
  url: string,
): { bucket: string; key: string } | null {
  const trimmed = url.trim();
  if (!trimmed.startsWith(R2_STAGING_PREFIX)) return null;
  const rest = trimmed.slice(R2_STAGING_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  const bucket = rest.slice(0, slash);
  const key = rest.slice(slash + 1).replace(/^\/+/, "");
  if (!bucket || !key) return null;
  return { bucket, key };
}

export function isR2StagingUrl(url: string): boolean {
  return parseR2StagingUrl(url) != null;
}

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

export async function createR2PresignedUpload(opts: {
  key: string;
  contentType: string;
  contentLength: number;
  expiresInSeconds?: number;
}): Promise<{ uploadUrl: string; stagingUrl: string; key: string; bucket: string }> {
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
  return {
    uploadUrl,
    stagingUrl: toR2StagingUrl(config.bucket, key),
    key,
    bucket: config.bucket,
  };
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

  // Node.js readable / async iterable from AWS SDK
  if (Symbol.asyncIterator in Object(body)) {
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      const buf = Buffer.from(chunk);
      total += buf.byteLength;
      if (total > maxBytes) throw new Error("Audio object exceeds size limit");
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  }

  // Web ReadableStream
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

export async function fetchR2Audio(stagingUrl: string): Promise<Buffer> {
  const config = readR2Config();
  if (!config) throw new Error("R2 is not configured");

  const parsed =
    parseR2StagingUrl(stagingUrl) ?? parseR2PublicUrl(stagingUrl, config);
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

export async function deleteR2Quiet(stagingUrl: string): Promise<void> {
  try {
    const config = readR2Config();
    if (!config) return;
    const parsed =
      parseR2StagingUrl(stagingUrl) ?? parseR2PublicUrl(stagingUrl, config);
    if (!parsed || parsed.bucket !== config.bucket) return;
    const client = r2Client(config);
    await client.send(
      new DeleteObjectCommand({
        Bucket: parsed.bucket,
        Key: parsed.key,
      }),
    );
  } catch {
    // best-effort cleanup after ingest
  }
}

export async function putR2Object(opts: {
  key: string;
  body: Buffer;
  contentType: string;
}): Promise<{ stagingUrl: string; key: string; bucket: string }> {
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
  return {
    stagingUrl: toR2StagingUrl(config.bucket, key),
    key,
    bucket: config.bucket,
  };
}
