-- Durable audio lives in Cloudflare R2; Postgres keeps the object key/URL.
-- Legacy audio_data is cleared by migrate-audio-data-to-r2, then dropped in 010.
alter table songs add column if not exists r2_object_key text;
alter table songs add column if not exists r2_object_url text;
alter table songs alter column audio_data drop not null;

create index if not exists songs_r2_object_key_idx on songs (r2_object_key)
  where r2_object_key is not null;
