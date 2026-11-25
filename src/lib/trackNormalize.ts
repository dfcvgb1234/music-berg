/** Strip remaster / soundtrack / live clutter so variants share a base title. */
export function normalizeTitle(title: string): string {
  let t = title.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");

  // Drop featuring credits in parentheses
  t = t.replace(
    /\s*[([{][^)\]}]*\b(feat\.?|ft\.?|featuring)\b[^)\]}]*[)\]}]/gi,
    "",
  );

  // Drop common edition/version markers in parentheses or brackets.
  // Avoid eating proper names like "(Live Aid)" — only strip live when it's a
  // version tag (bare "live", "live at/from/in …", "live version").
  t = t.replace(
    /\s*[([{][^)\]}]*(remaster(?:ed)?|remix|mixed|acoustic|instrumental|radio\s*edit|single\s*version|album\s*version|deluxe|expanded|anniversary|mono|stereo|edit|version|from\s+["“].*?["”]|soundtrack|ost|music\s+from|theme|bonus\s*track)[^)\]}]*[)\]}]/gi,
    "",
  );
  t = t.replace(
    /\s*[([{]\s*live(\s+(at|from|in|version)\b[^)\]}]*)?\s*[)\]}]/gi,
    "",
  );

  // "Title - Remastered 2011" / "Title – From the Soundtrack …"
  t = t.replace(
    /\s*[-–—:]\s*(remaster(?:ed)?(\s+\d{4})?|live(\s+(at|from|in)\b.*)?|radio\s*edit|single\s*version|album\s*version|from(\s+the)?\s+.+soundtrack.*|soundtrack\s+version.*)$/i,
    "",
  );

  // Trailing year
  t = t.replace(/\s+\(?\d{4}\)?\s*$/g, "");

  return t.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function normalizeArtist(artist: string): string {
  let a = artist.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  a = a.replace(/^the\s+/, "");
  a = a.replace(/\s*[([{][^)\]}]*\b(feat\.?|ft\.?|featuring)\b[^)\]}]*[)\]}]/gi, "");
  return a.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function trackFingerprint(artist: string, title: string): string {
  return `${normalizeArtist(artist)}|${normalizeTitle(title)}`;
}

const VARIANT_HINT =
  /\b(remaster(?:ed)?|remix|live|acoustic|soundtrack|ost|deluxe|expanded|anniversary|radio\s*edit|mono|stereo)\b/i;

/** Lower is better (more “canonical”). */
export function canonicalScore(hit: {
  title: string;
  album: string | null;
  coverArtUrl: string | null;
}): number {
  let score = 0;
  if (VARIANT_HINT.test(hit.title)) score += 8;
  if (hit.album && VARIANT_HINT.test(hit.album)) score += 5;
  if (/soundtrack|music from|ost\b/i.test(hit.album ?? "")) score += 4;
  if (!hit.coverArtUrl) score += 3;
  // Prefer shorter, cleaner titles
  score += Math.min(12, Math.floor(hit.title.length / 12));
  return score;
}
