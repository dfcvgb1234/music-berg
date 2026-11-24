-- Default / lobby clip length is 2 seconds (was 1s).
alter table sessions alter column clip_ms set default 2000;
update sessions set clip_ms = 2000 where status = 'lobby' and clip_ms = 1000;
