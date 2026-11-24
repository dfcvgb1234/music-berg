import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { newId } from "@/lib/ids";
import { pointsForClip } from "@/lib/normalize";
import {
  broadcastSession,
  buildSessionState,
  getSessionByCode,
  publicState,
} from "@/lib/quiz";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ code: string }> },
) {
  const { code } = await context.params;
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
  const musicbrainzId = String(body?.musicbrainzId ?? "").trim();
  const guessLabel = String(body?.label ?? body?.guess ?? "").trim().slice(0, 120);
  if (!musicbrainzId || !/^[0-9a-f-]{36}$/i.test(musicbrainzId)) {
    return NextResponse.json(
      { error: "Pick a MusicBrainz recording" },
      { status: 400 },
    );
  }

  const songs = await sql<{
    id: string;
    display_name: string;
    musicbrainz_id: string | null;
  }>(
    `select id, display_name, musicbrainz_id from songs where template_id = $1
     order by sort_order asc, created_at asc`,
    [session.template_id],
  );
  const song = songs[session.current_song_index];
  if (!song) {
    return NextResponse.json({ error: "No current song" }, { status: 400 });
  }
  if (!song.musicbrainz_id) {
    return NextResponse.json(
      { error: "This round has no MusicBrainz id" },
      { status: 400 },
    );
  }

  const prior = await sql<{ id: string; correct: boolean }>(
    `select id, correct from guesses
     where session_id = $1 and participant_id = $2 and song_index = $3`,
    [session.id, participant.id, session.current_song_index],
  );
  if (prior[0]) {
    const state = await buildPublic(code);
    return NextResponse.json(
      {
        correct: prior[0].correct,
        alreadyGuessed: true,
        lockedOut: true,
        message: prior[0].correct
          ? "You already got this one"
          : "No more guesses this round",
        state,
      },
      { status: 409 },
    );
  }

  const correct =
    musicbrainzId.toLowerCase() === song.musicbrainz_id.toLowerCase();
  const points = correct ? pointsForClip(session.clip_ms) : 0;

  await sql(
    `insert into guesses (id, session_id, participant_id, song_index, guess_text, correct)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      newId(),
      session.id,
      participant.id,
      session.current_song_index,
      guessLabel || musicbrainzId,
      correct,
    ],
  );

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
