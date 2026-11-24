import { NextResponse } from "next/server";
import { searchRecordings } from "@/lib/musicbrainz";
import { clientKey, rateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const ip = clientKey(request);
  if (!rateLimit(`mb-search:${ip}`, { limit: 30, windowMs: 60_000 })) {
    return NextResponse.json({ error: "Too many searches" }, { status: 429 });
  }

  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) {
    return NextResponse.json({ results: [] });
  }

  try {
    const results = await searchRecordings(q, 8);
    return NextResponse.json({ results });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "MusicBrainz unavailable",
      },
      { status: 502 },
    );
  }
}
