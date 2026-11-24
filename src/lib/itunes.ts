export type ItunesTrackHit = {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  coverArtUrl: string | null;
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

function mapResult(row: NonNullable<ItunesSearchJson["results"]>[number]): ItunesTrackHit | null {
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

export async function searchSongs(
  query: string,
  limit = 20,
  country = DEFAULT_COUNTRY,
): Promise<ItunesTrackHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const url =
    `https://itunes.apple.com/search?` +
    new URLSearchParams({
      term: q,
      entity: "song",
      country,
      limit: String(Math.min(25, Math.max(1, limit))),
    }).toString();

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Search failed (${res.status})`);
  }
  const data = (await res.json()) as ItunesSearchJson;
  const hits: ItunesTrackHit[] = [];
  for (const row of data.results ?? []) {
    const mapped = mapResult(row);
    if (mapped) hits.push(mapped);
  }
  return hits;
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
    if (mapped && mapped.id === id) return mapped;
  }
  // lookup returns the track even without kind filter sometimes
  for (const row of data.results ?? []) {
    if (row.trackId && String(row.trackId) === id && row.trackName) {
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
  }
  return null;
}

export function formatTrackLabel(hit: { title: string; artist: string }): string {
  return `${hit.artist} — ${hit.title}`;
}
