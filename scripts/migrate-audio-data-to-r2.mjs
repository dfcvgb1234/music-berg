#!/usr/bin/env node
/**
 * Move durable song audio from Postgres bytea (songs.audio_data) into
 * Cloudflare R2. Updates r2_object_key / r2_object_url and nulls audio_data.
 * Does not print secret values.
 *
 * Usage:
 *   node scripts/migrate-audio-data-to-r2.mjs           # dry-run (default)
 *   node scripts/migrate-audio-data-to-r2.mjs --execute
 *
 * Required env: DATABASE_URL, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 * Optional: R2_BUCKET (default music-berg), R2_PUBLIC_BASE_URL
 */

import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import pg from "pg";

const args = new Set(process.argv.slice(2));
const dryRun = !args.has("--execute");

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

function guessExt(mime) {
  const m = (mime || "").toLowerCase();
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("webm")) return "webm";
  return "ogg";
}

async function main() {
  console.log("migrate-audio-data-to-r2");
  console.log(`  mode: ${dryRun ? "dry-run (no writes)" : "EXECUTE"}`);

  const databaseUrl = requireEnv("DATABASE_URL");
  const accountId = requireEnv("R2_ACCOUNT_ID");
  const accessKeyId = requireEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("R2_SECRET_ACCESS_KEY");
  const bucket = process.env.R2_BUCKET?.trim() || "music-berg";
  const publicBase =
    process.env.R2_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") || "";

  console.log("  env present:");
  console.log(`    DATABASE_URL: ${mask(databaseUrl)}`);
  console.log(`    R2_ACCOUNT_ID: ${mask(accountId)}`);
  console.log(`    R2_ACCESS_KEY_ID: ${mask(accessKeyId)}`);
  console.log(`    R2_SECRET_ACCESS_KEY: ${mask(secretAccessKey)}`);
  console.log(`    R2_BUCKET: ${bucket}`);
  console.log(
    `    R2_PUBLIC_BASE_URL: ${publicBase ? mask(publicBase) : "(unset)"}`,
  );

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const r2 = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });

  // Ensure schema columns exist (009 may already have run via build migrate).
  await pool.query(`
    alter table songs add column if not exists r2_object_key text;
    alter table songs add column if not exists r2_object_url text;
    alter table songs alter column audio_data drop not null;
  `);

  const { rows } = await pool.query(
    `select id, mime_type, octet_length(audio_data) as nbytes, r2_object_key
     from songs
     where audio_data is not null
       and octet_length(audio_data) > 0
       and (r2_object_key is null or r2_object_key = '')
     order by created_at asc`,
  );

  console.log(`  candidates: ${rows.length}`);

  let wouldCopy = 0;
  let copied = 0;
  let skipped = 0;
  let failed = 0;
  let cleared = 0;

  for (const row of rows) {
    const key = `songs/${row.id}.${guessExt(row.mime_type)}`;
    const nbytes = Number(row.nbytes ?? 0);

    let exists = false;
    try {
      await r2.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      exists = true;
    } catch {
      exists = false;
    }

    if (exists && !dryRun) {
      const objectUrl = publicBase
        ? `${publicBase}/${key}`
        : `r2://${bucket}/${key}`;
      await pool.query(
        `update songs
         set r2_object_key = $2, r2_object_url = $3, audio_data = null
         where id = $1`,
        [row.id, key, objectUrl],
      );
      skipped += 1;
      cleared += 1;
      console.log(`  linked existing: ${key} (cleared audio_data)`);
      continue;
    }

    if (dryRun) {
      wouldCopy += 1;
      console.log(`  would copy: song ${row.id} → ${key} (${nbytes} bytes)`);
      continue;
    }

    try {
      const full = await pool.query(
        `select audio_data, mime_type from songs where id = $1`,
        [row.id],
      );
      const audio = full.rows[0]?.audio_data;
      if (!audio) {
        skipped += 1;
        continue;
      }
      const body = Buffer.isBuffer(audio) ? audio : Buffer.from(audio);
      const contentType = full.rows[0]?.mime_type || "audio/ogg";
      await r2.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ContentLength: body.byteLength,
        }),
      );
      const objectUrl = publicBase
        ? `${publicBase}/${key}`
        : `r2://${bucket}/${key}`;
      await pool.query(
        `update songs
         set r2_object_key = $2, r2_object_url = $3, audio_data = null
         where id = $1`,
        [row.id, key, objectUrl],
      );
      copied += 1;
      cleared += 1;
      console.log(`  copied: ${key} (${body.byteLength} bytes)`);
    } catch (err) {
      failed += 1;
      console.error(
        `  FAIL song ${row.id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  const left = await pool.query(
    `select count(*)::int as n from songs
     where audio_data is not null and octet_length(audio_data) > 0`,
  );
  const withKey = await pool.query(
    `select count(*)::int as n from songs
     where r2_object_key is not null and r2_object_key <> ''`,
  );

  console.log("");
  console.log("summary:");
  console.log(`  candidates: ${rows.length}`);
  console.log(
    `  ${dryRun ? "wouldCopy" : "copied"}: ${dryRun ? wouldCopy : copied}`,
  );
  console.log(`  skipped/linked: ${skipped}`);
  console.log(`  cleared audio_data: ${cleared}`);
  console.log(`  failed: ${failed}`);
  console.log(`  remaining with audio_data: ${left.rows[0]?.n ?? 0}`);
  console.log(`  songs with r2_object_key: ${withKey.rows[0]?.n ?? 0}`);
  if (dryRun) {
    console.log("");
    console.log("Re-run with --execute to upload and clear bytea.");
  }

  await pool.end();
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
