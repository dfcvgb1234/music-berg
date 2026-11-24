alter table songs add column if not exists itunes_track_id text;

create index if not exists songs_itunes_track_id_idx on songs(itunes_track_id);
