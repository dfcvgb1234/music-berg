/**
 * Verify durable R2 coverage before / after dropping songs.audio_data.
 *
 *   node scripts/verify-r2-audio.mjs
 *
 * Prints counts only (no secrets, no object keys dumped in bulk beyond totals).
 */
import pg from "pg";

const url = process.env.DATABASE_URL?.trim() ?? "";
if (!url) {
  console.error("verify-r2-audio: DATABASE_URL required");
  process.exit(1);
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL_UNPOOLED?.trim() || url,
});
await client.connect();

try {
  console.log("verify-r2-audio");

  const col = await client.query(
    `select 1 as ok
     from information_schema.columns
     where table_schema = 'public'
       and table_name = 'songs'
       and column_name = 'audio_data'`,
  );
  const hasAudioData = col.rows.length > 0;
  console.log(`  audio_data column: ${hasAudioData ? "present" : "GONE"}`);

  const totals = await client.query(
    `select
       count(*)::int as total,
       count(*) filter (
         where r2_object_key is not null and btrim(r2_object_key) <> ''
       )::int as with_r2_key,
       count(*) filter (
         where r2_object_key is null or btrim(r2_object_key) = ''
       )::int as missing_r2_key
     from songs`,
  );
  const t = totals.rows[0] ?? { total: 0, with_r2_key: 0, missing_r2_key: 0 };
  console.log(`  songs total: ${t.total}`);
  console.log(`  with r2_object_key: ${t.with_r2_key}`);
  console.log(`  missing r2_object_key: ${t.missing_r2_key}`);

  if (hasAudioData) {
    const left = await client.query(
      `select count(*)::int as n
       from songs
       where audio_data is not null and octet_length(audio_data) > 0`,
    );
    console.log(`  remaining with audio_data bytes: ${left.rows[0]?.n ?? 0}`);
  }

  const mig = await client.query(
    `select name from schema_migrations
     where name in ('009_r2_audio.sql', '010_drop_audio_data.sql')
     order by name`,
  );
  console.log(
    `  schema_migrations: ${mig.rows.map((r) => r.name).join(", ") || "(none of 009/010)"}`,
  );

  if (t.missing_r2_key > 0) {
    console.error("verify-r2-audio: FAIL — remigrate stragglers before drop");
    process.exit(2);
  }
  if (hasAudioData) {
    console.log("verify-r2-audio: OK for coverage; column still present (drop pending)");
  } else {
    console.log("verify-r2-audio: OK — column gone, all songs have r2_object_key");
  }
} finally {
  await client.end();
}
