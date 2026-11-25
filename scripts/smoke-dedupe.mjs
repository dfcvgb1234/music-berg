/**
 * Quick smoke test for title normalize + live Deezer collapse.
 */

function normalizeTitle(title) {
  let t = title.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  t = t.replace(
    /\s*[([{][^)\]}]*\b(feat\.?|ft\.?|featuring)\b[^)\]}]*[)\]}]/gi,
    "",
  );
  t = t.replace(
    /\s*[([{][^)\]}]*(remaster(?:ed)?|remix|mixed|acoustic|instrumental|radio\s*edit|single\s*version|album\s*version|deluxe|expanded|anniversary|mono|stereo|edit|version|from\s+["“].*?["”]|soundtrack|ost|music\s+from|theme|bonus\s*track)[^)\]}]*[)\]}]/gi,
    "",
  );
  t = t.replace(
    /\s*[([{]\s*live(\s+(at|from|in|version)\b[^)\]}]*)?\s*[)\]}]/gi,
    "",
  );
  t = t.replace(
    /\s*[-–—:]\s*(remaster(?:ed)?(\s+\d{4})?|live(\s+(at|from|in)\b.*)?|radio\s*edit|single\s*version|album\s*version|from(\s+the)?\s+.+soundtrack.*|soundtrack\s+version.*)$/i,
    "",
  );
  t = t.replace(/\s+\(?\d{4}\)?\s*$/g, "");
  return t.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeArtist(artist) {
  let a = artist.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  a = a.replace(/^the\s+/, "");
  a = a.replace(/\s*[([{][^)\]}]*\b(feat\.?|ft\.?|featuring)\b[^)\]}]*[)\]}]/gi, "");
  return a.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function trackFingerprint(artist, title) {
  return `${normalizeArtist(artist)}|${normalizeTitle(title)}`;
}

const shouldMatch = [
  ["Bohemian Rhapsody", "Bohemian Rhapsody (Remastered 2011)"],
  ["Lose Yourself", "Lose Yourself - Soundtrack Version"],
  ["Lose Yourself", 'Lose Yourself (From "8 Mile" Soundtrack)'],
  ["Hey Jude", "Hey Jude - Remastered 2015"],
  ["Wonderwall", "Wonderwall (Live)"],
  ["Wonderwall", "Wonderwall (Live at Knebworth)"],
];
const shouldDiffer = [
  ["Bohemian Rhapsody", "Bohemian Rhapsody (Live Aid)"],
];

let failed = 0;
for (const [a, b] of shouldMatch) {
  const fa = trackFingerprint("Artist", a);
  const fb = trackFingerprint("Artist", b);
  const ok = fa === fb;
  console.log(ok ? "OK match" : "FAIL match", JSON.stringify({ a, b, fa, fb }));
  if (!ok) failed++;
}
for (const [a, b] of shouldDiffer) {
  const fa = trackFingerprint("Artist", a);
  const fb = trackFingerprint("Artist", b);
  const ok = fa !== fb;
  console.log(ok ? "OK differ" : "FAIL differ", JSON.stringify({ a, b, fa, fb }));
  if (!ok) failed++;
}

const url =
  "https://api.deezer.com/search?" +
  new URLSearchParams({
    q: "bohemian rhapsody queen",
    limit: "40",
  }).toString();

const res = await fetch(url, { headers: { Accept: "application/json" } });
if (!res.ok) {
  console.error("Deezer search failed", res.status);
  process.exit(1);
}
const data = await res.json();
const groups = new Map();
for (const row of data.data ?? []) {
  if (row.readable === false) continue;
  if (!row.preview || !row.id) continue;
  const title = row.title_short || row.title;
  if (!title) continue;
  const key = trackFingerprint(row.artist?.name || "", title);
  if (key.endsWith("|") || !key.includes("|")) continue;
  const list = groups.get(key) ?? [];
  list.push({ id: row.id, title, album: row.album?.title });
  groups.set(key, list);
}

const multi = [...groups.entries()].filter(([, v]) => v.length > 1);
console.log(
  `Deezer raw=${data.total ?? (data.data ?? []).length} groups=${groups.size} withVariants=${multi.length}`,
);
if (multi[0]) {
  console.log("sample group:", multi[0][0], multi[0][1].slice(0, 4));
}

process.exit(failed ? 1 : 0);
