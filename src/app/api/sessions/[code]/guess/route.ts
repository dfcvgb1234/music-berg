import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { newId } from "@/lib/ids";
import { getTrack, trackFingerprint } from "@/lib/deezer";
import { pointsForClip } from "@/lib/normalize";
import {
  broadcastSession,
  buildSessionState,
  getSessionByCode,
  publicState,
} from "@/lib/quiz";
import { clientKey, rateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ code: string }> },
) {
  const { code } = await context.params;
  const ip = clientKey(request);
  if (!rateLimit(`guess:${ip}`, { limit: 60, windowMs: 60_000 })) {
    return NextResponse.json({ error: "Too many guesses" }, { status: 429 });
  }

  const session = await getSessionByCode(code);
  if (!session) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const participantToken = request.headers.get("x-participant-token") ?? "";
  if (!participantToken) {
    return NextResponse.json({ error: "Join the quiz first" }, { status: 401 });
  }

  const participants = await sql<{
    id: string;
    display_name: string;
    score: number;
  }>(
    `select id, display_name, score from participants
     where session_id = $1 and token = $2`,
    [session.id, participantToken],
  );
  const participant = participants[0];
  if (!participant) {
    return NextResponse.json({ error: "Unknown participant" }, { status: 401 });
  }

  if (session.status !== "playing") {
    return NextResponse.json(
      { error: "Wait for the host to play a clip" },
      { status: 400 },
    );
  }

  const body = await request.json().catch(() => null);
  const itunesTrackId = String(body?.itunesTrackId ?? "").trim();
  const guessLabel = String(body?.label ?? body?.guess ?? "").trim().slice(0, 120);
  if (!itunesTrackId || !/^\d+$/.test(itunesTrackId)) {
    return NextResponse.json(
      { error: "Pick a track from the search results" },
      { status: 400 },
    );
  }

  const songs = await sql<{
    id: string;
    display_name: string;
    itunes_track_id: string | null;
    itunes_answer_ids: string | null;
    answer_fingerprint: string | null;
  }>(
    `select id, display_name, itunes_track_id, itunes_answer_ids, answer_fingerprint
     from songs where template_id = $1
     order by sort_order asc, created_at asc`,
    [session.template_id],
  );
  const song = songs[session.current_song_index];
  if (!song) {
    return NextResponse.json({ error: "No current song" }, { status: 400 });
  }
  if (!song.itunes_track_id) {
    return NextResponse.json(
      { error: "This round has no track id" },
      { status: 400 },
    );
  }

  let answerIds: string[] = [song.itunes_track_id];
  if (song.itunes_answer_ids) {
    try {
      const parsed = JSON.parse(song.itunes_answer_ids) as unknown;
      if (Array.isArray(parsed)) {
        answerIds = [
          ...new Set(
            parsed
              .map((v) => String(v).trim())
              .filter((v) => /^\d+$/.test(v))
              .concat(song.itunes_track_id),
          ),
        ];
      }
    } catch {
      // keep primary only
    }
  }

  let correct = answerIds.includes(itunesTrackId);
  // Equivalent remaster / soundtrack cut: same normalized artist+title
  // as any allowed answer (primary or explicitly multi-selected).
  if (!correct && song.answer_fingerprint) {
    const guessed = await getTrack(itunesTrackId);
    if (guessed) {
      const fp = trackFingerprint(guessed.artist, guessed.title);
      let allowedFingerprints: string[] = [];
      try {
        const parsed = JSON.parse(song.answer_fingerprint) as unknown;
        if (Array.isArray(parsed)) {
          allowedFingerprints = parsed.map((v) => String(v));
        } else if (typeof parsed === "string") {
          allowedFingerprints = [parsed];
        }
      } catch {
        // Legacy single fingerprint string (not JSON).
        allowedFingerprints = [song.answer_fingerprint];
      }
      if (allowedFingerprints.includes(fp)) correct = true;
    }
  }

  const points = correct ? pointsForClip(session.clip_ms) : 0;
  const guessId = newId();

  // Unique index enforces one guess per round; concurrent inserts lose the race.
  const inserted = await sql<{ id: string; correct: boolean }>(
    `insert into guesses (id, session_id, participant_id, song_index, guess_text, correct)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (session_id, participant_id, song_index) do nothing
     returning id, correct`,
    [
      guessId,
      session.id,
      participant.id,
      session.current_song_index,
      guessLabel || itunesTrackId,
      correct,
    ],
  );

  if (!inserted[0]) {
    const prior = await sql<{ id: string; correct: boolean }>(
      `select id, correct from guesses
       where session_id = $1 and participant_id = $2 and song_index = $3`,
      [session.id, participant.id, session.current_song_index],
    );
    const state = await buildPublic(code);
    return NextResponse.json(
      {
        correct: prior[0]?.correct ?? false,
        alreadyGuessed: true,
        lockedOut: true,
        message: prior[0]?.correct
          ? "You already got this one"
          : "No more guesses this round",
        state,
      },
      { status: 409 },
    );
  }

  if (correct && points > 0) {
    await sql(`update participants set score = score + $1 where id = $2`, [
      points,
      participant.id,
    ]);
  }

  const state = await broadcastSession(code);
  return NextResponse.json({
    correct,
    points,
    lockedOut: true,
    answer: correct ? song.display_name : undefined,
    message: correct
      ? undefined
      : "Wrong — you're locked out for this round",
    state: state ? publicState(state) : null,
  });
}

async function buildPublic(code: string) {
  const state = await buildSessionState(code);
  return state ? publicState(state) : null;
}
