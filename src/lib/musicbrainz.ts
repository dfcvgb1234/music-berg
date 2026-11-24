export type MbRecordingHit = {
  id: string;
  title: string;
  artist: string;
  releaseId: string | null;
  coverArtUrl: string | null;
};

const USER_AGENT =
  "RiffRush/1.0 (https://riff-rush.apps.grok.bot; music-quiz-app)";

let lastRequestAt = 0;
let queue: Promise<unknown> = Promise.resolve();

/** MusicBrainz asks for ≤1 req/s; serialize outbound calls and retry 503s. */
async function throttledFetch(url: string): Promise<Response> {
  const run = async (): Promise<Response> => {
    let last: Response | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const wait = Math.max(0, 1100 - (Date.now() - lastRequestAt));
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastRequestAt = Date.now();
      last = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        cache: "no-store",
      });
      if (last.status !== 503) return last;
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
    return last!;
  };
  const next = queue.then(run, run);
  queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function coverUrl(releaseId: string | null): string | null {
  if (!releaseId) return null;
  // Served via our proxy so CSP img-src 'self' allows it.
  return `/api/cover-art/${releaseId}`;
}

type MbSearchJson = {
  recordings?: Array<{
    id: string;
    title: string;
    "artist-credit"?: Array<{ name?: string; artist?: { name?: string } }>;
    releases?: Array<{ id: string }>;
  }>;
};

export async function searchRecordings(
  query: string,
  limit = 8,
): Promise<MbRecordingHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const url =
    `https://musicbrainz.org/ws/2/recording?` +
    new URLSearchParams({
      query: q,
      fmt: "json",
      limit: String(Math.min(25, Math.max(1, limit))),
    }).toString();

  const res = await throttledFetch(url);
  if (!res.ok) {
    throw new Error(`MusicBrainz search failed (${res.status})`);
  }
  const data = (await res.json()) as MbSearchJson;
  const rows = data.recordings ?? [];

  return rows.map((rec) => {
    const artist =
      rec["artist-credit"]
        ?.map((c) => c.name || c.artist?.name || "")
        .filter(Boolean)
        .join(", ") || "Unknown artist";
    const releaseId = rec.releases?.[0]?.id ?? null;
    return {
      id: rec.id,
      title: rec.title,
      artist,
      releaseId,
      coverArtUrl: coverUrl(releaseId),
    };
  });
}

export async function getRecording(id: string): Promise<MbRecordingHit | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const url =
    `https://musicbrainz.org/ws/2/recording/${encodeURIComponent(id)}?` +
    new URLSearchParams({ fmt: "json", inc: "artists+releases" }).toString();
  const res = await throttledFetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`MusicBrainz lookup failed (${res.status})`);
  const rec = (await res.json()) as {
    id: string;
    title: string;
    "artist-credit"?: Array<{ name?: string; artist?: { name?: string } }>;
    releases?: Array<{ id: string }>;
  };
  const artist =
    rec["artist-credit"]
      ?.map((c) => c.name || c.artist?.name || "")
      .filter(Boolean)
      .join(", ") || "Unknown artist";
  const releaseId = rec.releases?.[0]?.id ?? null;
  return {
    id: rec.id,
    title: rec.title,
    artist,
    releaseId,
    coverArtUrl: coverUrl(releaseId),
  };
}

export function formatMbLabel(hit: {
  title: string;
  artist: string;
}): string {
  return `${hit.artist} — ${hit.title}`;
}
