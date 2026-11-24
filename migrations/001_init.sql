create table if not exists templates (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists songs (
  id text primary key,
  template_id text not null references templates(id) on delete cascade,
  display_name text not null,
  mime_type text not null default 'audio/mpeg',
  audio_data bytea not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists songs_template_id_idx on songs(template_id);

create table if not exists sessions (
  id text primary key,
  code text not null unique,
  template_id text not null references templates(id),
  host_token text not null,
  status text not null default 'lobby',
  current_song_index int not null default 0,
  clip_ms int not null default 1000,
  play_token int not null default 0,
  play_started_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists sessions_code_idx on sessions(code);

create table if not exists participants (
  id text primary key,
  session_id text not null references sessions(id) on delete cascade,
  display_name text not null,
  token text not null unique,
  score int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists participants_session_id_idx on participants(session_id);

create table if not exists guesses (
  id text primary key,
  session_id text not null references sessions(id) on delete cascade,
  participant_id text not null references participants(id) on delete cascade,
  song_index int not null,
  guess_text text not null,
  correct boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists guesses_session_song_idx on guesses(session_id, song_index);
