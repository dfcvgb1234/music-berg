# Bergs Music

Realtime music quiz: short clips, longer extends, race the room to name the track.

## Flow

1. **Frontpage** — Participate or Start new quiz.
2. **Host** — Pick a track list (or create a new one) → get a 6-digit room code → Play (1s) / Extend (+2s) / Reveal / Next.
3. **Participants** — Join with code + display name → hear the clipped audio → pick the track from search results.

## Notes

- App upload caps: **6 MB per MP3**, **48 MB total** per track list (up to 8 songs).
- Creating track lists requires `RIFFRUSH_UPLOAD_SECRET` (header `x-upload-secret`). Locally, `local-dev-upload` works when `DATABASE_URL` is unset.
