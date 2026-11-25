-- Segment unlock points on each song (JSON array of ms from clip start).
alter table songs add column if not exists segment_points_ms text;

-- Count of Unlock presses this round (accurate scoring with irregular segment jumps).
alter table sessions add column if not exists extend_count int not null default 0;
