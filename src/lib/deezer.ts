import { trackFingerprint } from "@/lib/trackNormalize";

export type DeezerTrackHit = {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  coverArtUrl: string | null;
  /** 30s MP3 preview from Deezer CDN (empty when unavailable). */
  previewUrl: string | null;
  /** Track length in seconds, when provided. */
  duration: number | null;
  /** All Deezer track ids collapsed into this deduped row (includes `id`). */
  matchedIds: string[];
  /** Extra variants merged away (for UI hints). */
  variantCount: number;
};

type DeezerSearchTrack = {
  id?: number;
  readable?: boolean;
  title?: string;
  title_short?: string;
  preview?: string;
  duration?: number;
  artist?: { name?: string };
  album?: {
    title?: string;
    cover_medium?: string;
    cover_big?: string;
  };
};

type DeezerSearchJson = {
  data?: DeezerSearchTrack[];
  total?: number;
  next?: string;
};

type DeezerTrackJson = DeezerSearchTrack & {
  error?: { type?: string; message?: string; code?: number };
};

function mapTrack(
  row: DeezerSearchTrack,
  opts: { requirePreview?: boolean } = {},
): Omit<DeezerTrackHit, "matchedIds" | "variantCount"> | null {
  const requirePreview = opts.requirePreview !== false;
  if (row.readable === false) return null;
  const preview = typeof row.preview === "string" ? row.preview.trim() : "";
  if (requirePreview && !preview) return null;

  const id = row.id != null ? String(row.id) : "";
  if (!id || !/^\d+$/.test(id)) return null;

  const title = (row.title || row.title_short || "").trim();
  if (!title) return null;

  const cover =
    row.album?.cover_medium?.trim() ||
    row.album?.cover_big?.trim() ||
    null;

  return {
    id,
    title,
    artist: row.artist?.name?.trim() || "Unknown artist",
    album: row.album?.title?.trim() || null,
    coverArtUrl: cover,
    previewUrl: preview || null,
    duration:
      typeof row.duration === "number" && Number.isFinite(row.duration)
        ? row.duration
        : null,
  };
}

/**
 * Collapse remasters / near-duplicates into one row per artist + base title.
 * Preserves Deezer relevance order (first occurrence keeps the slot and face).
 */
export function dedupeTrackHits(
  hits: Omit<DeezerTrackHit, "matchedIds" | "variantCount">[],
  limit = 12,
): DeezerTrackHit[] {
  const groups = new Map<
    string,
    {
      best: Omit<DeezerTrackHit, "matchedIds" | "variantCount">;
      ids: string[];
      order: number;
    }
  >();

  let order = 0;
  for (const hit of hits) {
    const key = trackFingerprint(hit.artist, hit.title);
    if (key.endsWith("|") || !key.includes("|")) continue;

    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        best: hit,
        ids: [hit.id],
        order: order++,
      });
      continue;
    }
    // Keep the first (most relevant) Deezer hit as the face; only merge ids /
    // backfill missing artwork from later variants.
    if (!existing.ids.includes(hit.id)) existing.ids.push(hit.id);
    if (!existing.best.coverArtUrl && hit.coverArtUrl) {
      existing.best = { ...existing.best, coverArtUrl: hit.coverArtUrl };
    }
  }

  return [...groups.values()]
    .sort((a, b) => a.order - b.order)
    .slice(0, limit)
    .map(({ best, ids }) => ({
      ...best,
      matchedIds: ids,
      variantCount: Math.max(0, ids.length - 1),
    }));
}

export async function searchSongs(
  query: string,
  limit = 12,
): Promise<DeezerTrackHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  // Over-fetch so dedupe still has enough distinct songs after collapsing variants.
  const fetchLimit = Math.min(50, Math.max(25, limit * 3));
  const url =
    `https://api.deezer.com/search?` +
    new URLSearchParams({
      q,
      limit: String(fetchLimit),
    }).toString();

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Search failed (${res.status})`);
  }
  const data = (await res.json()) as DeezerSearchJson;
  const raw: Omit<DeezerTrackHit, "matchedIds" | "variantCount">[] = [];
  for (const row of data.data ?? []) {
    const mapped = mapTrack(row);
    if (mapped) raw.push(mapped);
  }
  return dedupeTrackHits(raw, limit);
}

export async function getTrack(id: string): Promise<DeezerTrackHit | null> {
  if (!/^\d+$/.test(id)) return null;

  const res = await fetch(`https://api.deezer.com/track/${id}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Track lookup failed (${res.status})`);
  const data = (await res.json()) as DeezerTrackJson;
  if (data.error) return null;
  // Lookups may omit preview (CDN expiry); search still requires a preview URL.
  const mapped = mapTrack(data, { requirePreview: false });
  if (!mapped || mapped.id !== id) return null;
  return { ...mapped, matchedIds: [mapped.id], variantCount: 0 };
}

export async function getTracks(
  ids: string[],
): Promise<Map<string, DeezerTrackHit>> {
  const unique = [...new Set(ids.filter((id) => /^\d+$/.test(id)))];
  const out = new Map<string, DeezerTrackHit>();

  // Deezer has no batch lookup; fetch in small parallel batches.
  for (let i = 0; i < unique.length; i += 8) {
    const batch = unique.slice(i, i + 8);
    const settled = await Promise.all(
      batch.map(async (trackId) => {
        try {
          return await getTrack(trackId);
        } catch {
          return null;
        }
      }),
    );
    for (const hit of settled) {
      if (hit) out.set(hit.id, hit);
    }
  }
  return out;
}

export function formatTrackLabel(hit: { title: string; artist: string }): string {
  return `${hit.artist} — ${hit.title}`;
}

export { trackFingerprint };
