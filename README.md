# Bergs Music

Realtime music quiz: short clips, longer extends, race the room to name the track.

## Flow

1. **Frontpage** — Participate or Start new quiz.
2. **Host** — Pick a track list (or create a new one) → get a 6-digit room code → Play (2s) / Unlock (+2s, −2 pts) / Reveal / Next. **Audio plays only on the host.**
3. **Participants** — Join with code + display name → guess from search. First unlock **2s / 10 pts**; each unlock adds **+2s, +4s, +6s, …** and **−2 pts**.

## Notes

- App upload caps: **6 MB per file**, **50 MB total audio** per track list (no song-count cap).
- Creating track lists requires `BERGS_MUSIC_UPLOAD_SECRET` or legacy `RIFFRUSH_UPLOAD_SECRET` (header `x-upload-secret`). Locally, uploads work without a secret when `DATABASE_URL` is unset.
- Authors can add **multiple accepted answers** per track; guesses also match by normalized artist+title fingerprint.
- Session audio is **host-token only** — participants never receive clips or full tracks.

## Deploy on Vercel

See [docs/vercel.md](docs/vercel.md). You need `DATABASE_URL` (Postgres), an upload secret, and for Hobby-safe ~5MB MP3s: a private Blob store with `BLOB_READ_WRITE_TOKEN` (client uploads bypass the 4.5MB function body cap).
