-- Cropped clip length (ms) for non-segmented "last unlock = full track".
alter table songs add column if not exists duration_ms int;
