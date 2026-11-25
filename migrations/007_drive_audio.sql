-- Google Drive durable audio: store file IDs instead of (or alongside) bytea.
alter table songs add column if not exists drive_file_id text;

-- Allow rows that only reference Drive (no Postgres bytea payload).
alter table songs alter column audio_data drop not null;

create index if not exists songs_drive_file_id_idx
  on songs(drive_file_id)
  where drive_file_id is not null;
