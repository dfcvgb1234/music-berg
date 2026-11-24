import {
  canonicalScore,
  trackFingerprint,
} from "@/lib/trackNormalize";

export type ItunesTrackHit = {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  coverArtUrl: string | null;
  /** All iTunes trackIds collapsed into this deduped row (includes `id`). */
  matchedIds: string[];
  /** Extra variants merged away (for UI hints). */
  variantCount: number;
};

type ItunesSearchJson = {
  resultCount?: number;
  results?: Array<{
    wrapperType?: string;
    kind?: string;
    trackId?: number;
    trackName?: string;
    artistName?: string;
    collectionName?: string;
    artworkUrl30?: string;
    artworkUrl60?: string;
    artworkUrl100?: string;
  }>;
};

const DEFAULT_COUNTRY = "DK";

/** Prefer a larger artwork URL when iTunes returns the 100px variant. */
export function upgradeArtworkUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.replace(/\/(\d+)x\1(bb)?\./, "/300x300$2.");
}

function mapResult(
  row: NonNullable<ItunesSearchJson["results"]>[number],
): Omit<ItunesTrackHit, "matchedIds" | "variantCount"> | null {
  if (row.wrapperType === "track" || row.kind === "song") {
    if (!row.trackId || !row.trackName) return null;
    return {
      id: String(row.trackId),
      title: row.trackName,
      artist: row.artistName || "Unknown artist",
      album: row.collectionName ?? null,
      coverArtUrl: upgradeArtworkUrl(
        row.artworkUrl100 || row.artworkUrl60 || row.artworkUrl30,
      ),
    };
  }
  return null;
}

/**
 * Collapse remasters / soundtrack cuts / near-duplicates into one row per
 * artist + base title, keeping the most canonical listing as the face.
 */
export function dedupeTrackHits(
  hits: Omit<ItunesTrackHit, "matchedIds" | "variantCount">[],
  limit = 12,
): ItunesTrackHit[] {
  const groups = new Map<
    string,
    {
      best: Omit<ItunesTrackHit, "matchedIds" | "variantCount">;
      bestScore: number;
      ids: string[];
    }
  >();

  for (const hit of hits) {
    const key = trackFingerprint(hit.artist, hit.title);
    if (!key.endsWith("|") && key.includes("|")) {
      const score = canonicalScore(hit);
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, { best: hit, bestScore: score, ids: [hit.id] });
        continue;
      }
      if (!existing.ids.includes(hit.id)) existing.ids.push(hit.id);
      if (score < existing.bestScore) {
        existing.best = hit;
        existing.bestScore = score;
      } else if (
        score === existing.bestScore &&
        !existing.best.coverArtUrl &&
        hit.coverArtUrl
      ) {
        existing.best = { ...existing.best, coverArtUrl: hit.coverArtUrl };
      }
    }
  }

  const ranked = [...groups.values()].sort(
    (a, b) => a.bestScore - b.bestScore,
  );

  return ranked.slice(0, limit).map(({ best, ids }) => ({
    ...best,
    matchedIds: ids,
    variantCount: Math.max(0, ids.length - 1),
  }));
}

export async function searchSongs(
  query: string,
  limit = 12,
  country = DEFAULT_COUNTRY,
): Promise<ItunesTrackHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  // Over-fetch so dedupe still has enough distinct songs after collapsing variants.
  const fetchLimit = Math.min(50, Math.max(25, limit * 3));
  const url =
    `https://itunes.apple.com/search?` +
    new URLSearchParams({
      term: q,
      entity: "song",
      country,
      limit: String(fetchLimit),
    }).toString();

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Search failed (${res.status})`);
  }
  const data = (await res.json()) as ItunesSearchJson;
  const raw: Omit<ItunesTrackHit, "matchedIds" | "variantCount">[] = [];
  for (const row of data.results ?? []) {
    const mapped = mapResult(row);
    if (mapped) raw.push(mapped);
  }
  return dedupeTrackHits(raw, limit);
}

export async function getTrack(
  id: string,
  country = DEFAULT_COUNTRY,
): Promise<ItunesTrackHit | null> {
  if (!/^\d+$/.test(id)) return null;

  const url =
    `https://itunes.apple.com/lookup?` +
    new URLSearchParams({ id, country, entity: "song" }).toString();

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Track lookup failed (${res.status})`);
  const data = (await res.json()) as ItunesSearchJson;
  for (const row of data.results ?? []) {
    const mapped = mapResult(row);
    if (mapped && mapped.id === id) {
      return { ...mapped, matchedIds: [mapped.id], variantCount: 0 };
    }
  }
  for (const row of data.results ?? []) {
    if (row.trackId && String(row.trackId) === id && row.trackName) {
      const mapped = {
        id: String(row.trackId),
        title: row.trackName,
        artist: row.artistName || "Unknown artist",
        album: row.collectionName ?? null,
        coverArtUrl: upgradeArtworkUrl(
          row.artworkUrl100 || row.artworkUrl60 || row.artworkUrl30,
        ),
      };
      return { ...mapped, matchedIds: [mapped.id], variantCount: 0 };
    }
  }
  return null;
}

export async function getTracks(
  ids: string[],
  country = DEFAULT_COUNTRY,
): Promise<Map<string, ItunesTrackHit>> {
  const unique = [...new Set(ids.filter((id) => /^\d+$/.test(id)))];
  const out = new Map<string, ItunesTrackHit>();
  // iTunes lookup accepts comma-separated ids (cap batches).
  for (let i = 0; i < unique.length; i += 20) {
    const batch = unique.slice(i, i + 20);
    const url =
      `https://itunes.apple.com/lookup?` +
      new URLSearchParams({
        id: batch.join(","),
        country,
        entity: "song",
      }).toString();
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) continue;
    const data = (await res.json()) as ItunesSearchJson;
    for (const row of data.results ?? []) {
      const mapped = mapResult(row);
      if (mapped) {
        out.set(mapped.id, {
          ...mapped,
          matchedIds: [mapped.id],
          variantCount: 0,
        });
      }
    }
  }
  return out;
}

export function formatTrackLabel(hit: { title: string; artist: string }): string {
  return `${hit.artist} — ${hit.title}`;
}

export { trackFingerprint };
