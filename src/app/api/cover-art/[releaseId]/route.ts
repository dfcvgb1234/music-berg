import { NextResponse } from "next/server";

export const runtime = "nodejs";

const USER_AGENT =
  "RiffRush/1.0 (https://riff-rush.apps.grok.bot; music-quiz-app)";

/**
 * Proxy Cover Art Archive so the browser never needs third-party cookies
 * and we can set a polite User-Agent.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ releaseId: string }> },
) {
  const { releaseId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(releaseId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const upstream = await fetch(
    `https://coverartarchive.org/release/${releaseId}/front-250`,
    {
      headers: { "User-Agent": USER_AGENT, Accept: "image/*" },
      redirect: "follow",
      cache: "force-cache",
    },
  );

  if (!upstream.ok) {
    return new NextResponse(null, { status: 404 });
  }

  const buf = Buffer.from(await upstream.arrayBuffer());
  const type = upstream.headers.get("content-type") || "image/jpeg";
  return new NextResponse(buf, {
    headers: {
      "Content-Type": type,
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
