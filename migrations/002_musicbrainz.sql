alter table songs add column if not exists musicbrainz_id text;
alter table songs add column if not exists cover_art_url text;
alter table songs add column if not exists artist_credit text;

create index if not exists songs_musicbrainz_id_idx on songs(musicbrainz_id);
