#!/usr/bin/env node
/**
 * Copy leftover Vercel Blob audio objects into Cloudflare R2 bucket `music-berg`
 * (or R2_BUCKET). Durable quiz audio on main lives in Postgres after template
 * ingest — Blob was staging only — so this mainly migrates orphaned staging
 * objects. Does not print secret values.
 *
 * Usage:
 *   node scripts/migrate-blob-to-r2.mjs              # dry-run (default)
 *   node scripts/migrate-blob-to-r2.mjs --dry-run
 *   node scripts/migrate-blob-to-r2.mjs --execute    # copy Blob → R2
 *   node scripts/migrate-blob-to-r2.mjs --execute --delete-source
 *
 * Required env:
 *   BLOB_READ_WRITE_TOKEN
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 * Optional:
 *   R2_BUCKET (default: music-berg)
 *   R2_PUBLIC_BASE_URL (documented for the app; unused by this copy)
 *   DATABASE_URL (optional; reports song count only — no Blob URL column on main)
 */

import { list, get } from "@vercel/blob";
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const args = new Set(process.argv.slice(2));
const dryRun = !args.has("--execute");
const deleteSource = args.has("--delete-source");

function requireEnv(name) {
  const v = process.env[name]?.trim() ?? "";
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

function mask(value) {
  if (!value) return "(unset)";
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}…${value.slice(-2)} (len=${value.length})`;
}

async function streamToBuffer(stream, maxBytes = 20 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > maxBytes) throw new Error("Object exceeds size limit");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function guessContentType(pathname) {
  const lower = pathname.toLowerCase();
  if (lower.endsWith(".ogg") || lower.endsWith(".opus")) return "audio/ogg";
  if (lower.endsWith(".webm")) return "audio/webm";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  return "application/octet-stream";
}

function blobPathToR2Key(urlOrPathname) {
  try {
    const u = new URL(urlOrPathname);
    return decodeURIComponent(u.pathname.replace(/^\/+/, "")).slice(0, 500);
  } catch {
    return String(urlOrPathname).replace(/^\/+/, "").slice(0, 500);
  }
}

async function main() {
  console.log("migrate-blob-to-r2");
  console.log(`  mode: ${dryRun ? "dry-run (no writes)" : "EXECUTE"}`);
  if (deleteSource && dryRun) {
    console.log("  note: --delete-source ignored in dry-run");
  }

  const blobToken = requireEnv("BLOB_READ_WRITE_TOKEN");
  const accountId = requireEnv("R2_ACCOUNT_ID");
  const accessKeyId = requireEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("R2_SECRET_ACCESS_KEY");
  const bucket = process.env.R2_BUCKET?.trim() || "music-berg";
  const publicBase = process.env.R2_PUBLIC_BASE_URL?.trim() || "";

  console.log("  env present:");
  console.log(`    BLOB_READ_WRITE_TOKEN: ${mask(blobToken)}`);
  console.log(`    R2_ACCOUNT_ID: ${mask(accountId)}`);
  console.log(`    R2_ACCESS_KEY_ID: ${mask(accessKeyId)}`);
  console.log(`    R2_SECRET_ACCESS_KEY: ${mask(secretAccessKey)}`);
  console.log(`    R2_BUCKET: ${bucket}`);
  console.log(
    `    R2_PUBLIC_BASE_URL: ${publicBase ? mask(publicBase) : "(unset)"}`,
  );

  if (process.env.DATABASE_URL?.trim()) {
    try {
      const pg = await import("pg");
      const pool = new pg.default.Pool({
        connectionString: process.env.DATABASE_URL,
        max: 1,
      });
      const { rows } = await pool.query(
        `select count(*)::int as n from songs where audio_data is not null`,
      );
      console.log(
        `  postgres: ${rows[0]?.n ?? 0} songs with audio_data (durable store; Blob was staging)`,
      );
      await pool.end();
    } catch (err) {
      console.log(
        `  postgres: skip (${err instanceof Error ? err.message : "error"})`,
      );
    }
  } else {
    console.log("  postgres: DATABASE_URL unset — skipping song count");
  }

  const r2 = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });

  let cursor;
  let listed = 0;
  let wouldCopy = 0;
  let copied = 0;
  let skipped = 0;
  let failed = 0;

  do {
    const page = await list({
      token: blobToken,
      cursor,
      limit: 100,
    });
    cursor = page.hasMore ? page.cursor : undefined;

    for (const blob of page.blobs) {
      listed += 1;
      const key = blobPathToR2Key(blob.pathname || blob.url);
      const contentType =
        blob.contentType || guessContentType(blob.pathname || key);
      const size = blob.size ?? 0;

      let exists = false;
      try {
        await r2.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        );
        exists = true;
      } catch {
        exists = false;
      }

      if (exists) {
        skipped += 1;
        console.log(`  skip (exists): ${key} (${size} bytes)`);
        continue;
      }

      wouldCopy += 1;
      if (dryRun) {
        console.log(`  would copy: ${key} (${size} bytes, ${contentType})`);
        continue;
      }

      try {
        const result = await get(blob.url, {
          access: "private",
          useCache: false,
          token: blobToken,
        });
        if (!result || result.statusCode !== 200 || !result.stream) {
          throw new Error(`get failed status=${result?.statusCode}`);
        }
        const body = await streamToBuffer(result.stream);
        await r2.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
            ContentLength: body.byteLength,
          }),
        );
        copied += 1;
        console.log(`  copied: r2://${bucket}/${key} (${body.byteLength} bytes)`);

        if (deleteSource) {
          const { del } = await import("@vercel/blob");
          await del(blob.url, { token: blobToken });
          console.log(`  deleted source blob: ${key}`);
        }
      } catch (err) {
        failed += 1;
        console.error(
          `  FAIL ${key}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  } while (cursor);

  console.log("");
  console.log("summary:");
  console.log(`  listed: ${listed}`);
  console.log(`  ${dryRun ? "wouldCopy" : "copied"}: ${dryRun ? wouldCopy : copied}`);
  console.log(`  skipped (already in R2): ${skipped}`);
  console.log(`  failed: ${failed}`);
  if (dryRun) {
    console.log("");
    console.log("Re-run with --execute to copy. Add --delete-source to remove Blob originals after copy.");
  }
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
