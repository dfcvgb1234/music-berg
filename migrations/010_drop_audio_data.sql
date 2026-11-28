-- Durable audio is only in Cloudflare R2. Drop legacy Postgres bytea.
-- Refuse to drop if any song still lacks an R2 object key.
do $$
declare
  missing int;
begin
  select count(*)::int into missing
  from songs
  where r2_object_key is null or btrim(r2_object_key) = '';
  if missing > 0 then
    raise exception
      'Cannot drop songs.audio_data: % song(s) missing r2_object_key',
      missing;
  end if;
end $$;

alter table songs drop column if exists audio_data;
