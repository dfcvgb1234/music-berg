import { sql } from "@/lib/db";
import { publish } from "@/lib/pubsub";

export type ParticipantView = {
  id: string;
  displayName: string;
  score: number;
  guessedCorrect: boolean;
};

export type SongMeta = {
  id: string;
  displayName: string;
  sortOrder: number;
};

export type SessionState = {
  code: string;
  status: string;
  templateId: string;
  templateName: string;
  currentSongIndex: number;
  songCount: number;
  clipMs: number;
  playToken: number;
  playStartedAt: string | null;
  currentSongId: string | null;
  /** Public answer when revealed; otherwise null for participants */
  currentSongName: string | null;
  /** Always set for host clients; stripped in publicState */
  hostSongName: string | null;
  revealAnswer: boolean;
  participants: ParticipantView[];
  everyoneCorrect: boolean;
};

type SessionRow = {
  id: string;
  code: string;
  template_id: string;
  host_token: string;
  status: string;
  current_song_index: number;
  clip_ms: number;
  play_token: number;
  play_started_at: string | Date | null;
  template_name: string;
};

type SongRow = {
  id: string;
  display_name: string;
  sort_order: number;
};

type ParticipantRow = {
  id: string;
  display_name: string;
  score: number;
};

export async function getSessionByCode(code: string): Promise<SessionRow | null> {
  const rows = await sql<SessionRow>(
    `select s.id, s.code, s.template_id, s.host_token, s.status,
            s.current_song_index, s.clip_ms, s.play_token, s.play_started_at,
            t.name as template_name
     from sessions s
     join templates t on t.id = s.template_id
     where s.code = $1`,
    [code.toUpperCase()],
  );
  return rows[0] ?? null;
}

export async function buildSessionState(
  code: string,
  opts: { revealAnswer?: boolean } = {},
): Promise<SessionState | null> {
  const session = await getSessionByCode(code);
  if (!session) return null;

  const songs = await sql<SongRow>(
    `select id, display_name, sort_order
     from songs where template_id = $1
     order by sort_order asc, created_at asc`,
    [session.template_id],
  );

  const participants = await sql<ParticipantRow>(
    `select id, display_name, score from participants
     where session_id = $1
     order by score desc, created_at asc`,
    [session.id],
  );

  const songIndex = session.current_song_index;
  const currentSong = songs[songIndex] ?? null;

  const correctGuesses = currentSong
    ? await sql<{ participant_id: string }>(
        `select participant_id from guesses
         where session_id = $1 and song_index = $2 and correct = true`,
        [session.id, songIndex],
      )
    : [];
  const correctSet = new Set(correctGuesses.map((g) => g.participant_id));

  const reveal =
    opts.revealAnswer === true ||
    session.status === "finished" ||
    session.status === "revealed";

  const participantViews: ParticipantView[] = participants.map((p) => ({
    id: p.id,
    displayName: p.display_name,
    score: p.score,
    guessedCorrect: correctSet.has(p.id),
  }));

  const everyoneCorrect =
    participants.length > 0 &&
    participants.every((p) => correctSet.has(p.id));

  return {
    code: session.code,
    status: session.status,
    templateId: session.template_id,
    templateName: session.template_name,
    currentSongIndex: songIndex,
    songCount: songs.length,
    clipMs: session.clip_ms,
    playToken: session.play_token,
    playStartedAt: session.play_started_at
      ? new Date(session.play_started_at).toISOString()
      : null,
    currentSongId: currentSong?.id ?? null,
    currentSongName: reveal && currentSong ? currentSong.display_name : null,
    hostSongName: currentSong?.display_name ?? null,
    revealAnswer: reveal,
    participants: participantViews,
    everyoneCorrect,
  };
}

export async function broadcastSession(
  code: string,
  opts: { revealAnswer?: boolean } = {},
): Promise<SessionState | null> {
  const state = await buildSessionState(code, opts);
  if (state) publish(code, { type: "state", state });
  return state;
}

export function publicState(state: SessionState): SessionState {
  return {
    ...state,
    hostSongName: null,
    currentSongName: state.revealAnswer ? state.currentSongName : null,
  };
}
