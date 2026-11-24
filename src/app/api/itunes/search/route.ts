import { NextResponse } from "next/server";
import { searchSongs } from "@/lib/itunes";
import { clientKey, rateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const ip = clientKey(request);
  if (!rateLimit(`itunes-search:${ip}`, { limit: 40, windowMs: 60_000 })) {
    return NextResponse.json({ error: "Too many searches" }, { status: 429 });
  }

  const params = new URL(request.url).searchParams;
  const q = params.get("q")?.trim() ?? "";
  if (q.length < 2) {
    return NextResponse.json({ results: [] });
  }

  try {
    const results = await searchSongs(q, 20, "DK");
    return NextResponse.json({ results });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Search unavailable",
      },
      { status: 502 },
    );
  }
}
