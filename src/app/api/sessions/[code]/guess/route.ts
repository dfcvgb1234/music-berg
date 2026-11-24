import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { newId } from "@/lib/ids";
import { answersMatch, pointsForClip } from "@/lib/normalize";
import {
  broadcastSession,
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
  const guessText = String(body?.guess ?? "").trim().slice(0, 80);
  if (!guessText) {
    return NextResponse.json({ error: "Enter a guess" }, { status: 400 });
  }

  const songs = await sql<{ id: string; display_name: string }>(
    `select id, display_name from songs where template_id = $1
     order by sort_order asc, created_at asc`,
    [session.template_id],
  );
  const song = songs[session.current_song_index];
  if (!song) {
    return NextResponse.json({ error: "No current song" }, { status: 400 });
  }

  const already = await sql<{ id: string }>(
    `select id from guesses
     where session_id = $1 and participant_id = $2 and song_index = $3 and correct = true`,
    [session.id, participant.id, session.current_song_index],
  );
  if (already[0]) {
    return NextResponse.json({
      correct: true,
      alreadyCorrect: true,
      message: "You already got this one",
    });
  }

  const correct = answersMatch(guessText, song.display_name);
  const points = correct ? pointsForClip(session.clip_ms) : 0;

  await sql(
    `insert into guesses (id, session_id, participant_id, song_index, guess_text, correct)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      newId(),
      session.id,
      participant.id,
      session.current_song_index,
      guessText,
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
    // Only confirm the title after a correct guess for this player.
    answer: correct ? song.display_name : undefined,
    state: state ? publicState(state) : null,
  });
}
