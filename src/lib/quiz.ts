import {
  canExtendClip,
  expansionsForClip,
  nextExtendCost,
  nextExtendDeltaMsForTrack,
  normalizeSegmentPointsMs,
  pointsForExtends,
} from "@/lib/clipRules";
import { sql } from "@/lib/db";
import { publish } from "@/lib/pubsub";
import {
  isSessionExpired,
  sessionExpiresAt,
  SESSION_TTL_MS,
} from "@/lib/sessionTtl";

export type ParticipantView = {
  id: string;
  displayName: string;
  score: number;
  guessedCorrect: boolean;
  /** True after any guess this round (correct or wrong) — no more attempts. */
  lockedOut: boolean;
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
  /** Unlock presses this round (for scoring with segment jumps). */
  extendCount: number;
  /** Segment boundaries (ms) for the current song; empty = progressive unlock. */
  segmentPointsMs: number[];
  /** Full cropped clip length when known. */
  durationMs: number | null;
  /** Next Unlock delta for the current song. */
  nextExtendMs: number;
  /** Points deducted by the next Unlock (0 if none left). */
  nextExtendCost: number;
  /** Points currently available for a correct guess. */
  pointsNow: number;
  /** False when clip is already full / max extends reached. */
  canExtend: boolean;
  playToken: number;
  playStartedAt: string | null;
  currentSongId: string | null;
  /** Public answer when revealed; otherwise null for participants */
  currentSongName: string | null;
  /** Cover art URL when revealed; otherwise null */
  currentCoverArtUrl: string | null;
  /** Always set for host clients; stripped in publicState */
  hostSongName: string | null;
  revealAnswer: boolean;
  participants: ParticipantView[];
  everyoneCorrect: boolean;
  /** ISO timestamp when the session was created. */
  createdAt: string | null;
  /** ISO timestamp when the session TTL elapses (~2.5h). */
  expiresAt: string | null;
};

type SessionRow = {
  id: string;
  code: string;
  template_id: string;
  host_token: string;
  status: string;
  current_song_index: number;
  clip_ms: number;
  extend_count: number | null;
  play_token: number;
  play_started_at: string | Date | null;
  created_at: string | Date;
  template_name: string;
};

type SongRow = {
  id: string;
  display_name: string;
  sort_order: number;
  cover_art_url: string | null;
  segment_points_ms: string | null;
  duration_ms: number | null;
};

type ParticipantRow = {
  id: string;
  display_name: string;
  score: number;
};

async function purgeSession(sessionId: string): Promise<void> {
  await sql(`delete from guesses where session_id = $1`, [sessionId]);
  await sql(`delete from participants where session_id = $1`, [sessionId]);
  await sql(`delete from sessions where id = $1`, [sessionId]);
}

/** Drop sessions older than SESSION_TTL_MS (best-effort sweep). */
export async function expireStaleSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - SESSION_TTL_MS).toISOString();
  const stale = await sql<{ id: string }>(
    `select id from sessions where created_at < $1`,
    [cutoff],
  );
  for (const row of stale) {
    await purgeSession(row.id);
  }
  return stale.length;
}

export async function getSessionByCode(code: string): Promise<SessionRow | null> {
  const rows = await sql<SessionRow>(
    `select s.id, s.code, s.template_id, s.host_token, s.status,
            s.current_song_index, s.clip_ms, s.extend_count, s.play_token, s.play_started_at,
            s.created_at, t.name as template_name
     from sessions s
     join templates t on t.id = s.template_id
     where s.code = $1`,
    [code.toUpperCase()],
  );
  const session = rows[0];
  if (!session) return null;
  if (isSessionExpired(session.created_at)) {
    await purgeSession(session.id);
    return null;
  }
  return session;
}

export async function buildSessionState(
  code: string,
  opts: { revealAnswer?: boolean } = {},
): Promise<SessionState | null> {
  const session = await getSessionByCode(code);
  if (!session) return null;

  const songs = await sql<SongRow>(
    `select id, display_name, sort_order, cover_art_url, segment_points_ms, duration_ms
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

  const roundGuesses = currentSong
    ? await sql<{ participant_id: string; correct: boolean }>(
        `select participant_id, correct from guesses
         where session_id = $1 and song_index = $2`,
        [session.id, songIndex],
      )
    : [];
  const correctSet = new Set(
    roundGuesses.filter((g) => g.correct).map((g) => g.participant_id),
  );
  const lockedSet = new Set(roundGuesses.map((g) => g.participant_id));

  const reveal =
    opts.revealAnswer === true ||
    session.status === "finished" ||
    session.status === "revealed";

  const participantViews: ParticipantView[] = participants.map((p) => ({
    id: p.id,
    displayName: p.display_name,
    score: p.score,
    guessedCorrect: correctSet.has(p.id),
    lockedOut: lockedSet.has(p.id),
  }));

  const everyoneCorrect =
    participants.length > 0 &&
    participants.every((p) => correctSet.has(p.id));

  const segmentPointsMs = normalizeSegmentPointsMs(
    currentSong?.segment_points_ms ?? null,
  );
  const durationMs =
    currentSong?.duration_ms != null &&
    Number.isFinite(Number(currentSong.duration_ms))
      ? Math.max(0, Number(currentSong.duration_ms))
      : null;
  const extendCount =
    session.extend_count != null && Number.isFinite(Number(session.extend_count))
      ? Math.max(0, Number(session.extend_count))
      : expansionsForClip(session.clip_ms);
  const clipOpts = {
    segmentPointsMs,
    durationMs,
    extendCount,
  };

  return {
    code: session.code,
    status: session.status,
    templateId: session.template_id,
    templateName: session.template_name,
    currentSongIndex: songIndex,
    songCount: songs.length,
    clipMs: session.clip_ms,
    extendCount,
    segmentPointsMs,
    durationMs,
    nextExtendMs: nextExtendDeltaMsForTrack(
      session.clip_ms,
      segmentPointsMs,
      durationMs,
      extendCount,
    ),
    nextExtendCost: nextExtendCost(extendCount),
    pointsNow: pointsForExtends(extendCount),
    canExtend: canExtendClip(session.clip_ms, clipOpts),
    playToken: session.play_token,
    playStartedAt: session.play_started_at
      ? new Date(session.play_started_at).toISOString()
      : null,
    currentSongId: currentSong?.id ?? null,
    // Only after host reveal / finish — never leak the answer on the big screen mid-round.
    currentSongName: reveal && currentSong ? currentSong.display_name : null,
    currentCoverArtUrl:
      reveal && currentSong ? currentSong.cover_art_url : null,
    hostSongName: null,
    revealAnswer: reveal,
    participants: participantViews,
    everyoneCorrect,
    createdAt: session.created_at
      ? new Date(session.created_at).toISOString()
      : null,
    expiresAt: session.created_at
      ? sessionExpiresAt(session.created_at).toISOString()
      : null,
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
    currentCoverArtUrl: state.revealAnswer ? state.currentCoverArtUrl : null,
  };
}
