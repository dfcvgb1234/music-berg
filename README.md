# RiffRush

Realtime music quiz for parties. Host plays short clips that can extend by +2s; participants guess the song name while scores update live.

## Run locally

```bash
npm install
env -u DATABASE_URL npm run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000).

Without `DATABASE_URL`, the app uses in-memory PGlite and applies `migrations/` on startup. With `DATABASE_URL` (published app), Postgres is used and migrations run during `npm run build`.

## Flow

1. **Frontpage** — Participate, Start new quiz, or create a template (name + MP3s).
2. **Host** — Pick a template → get a 6-digit room code → Play (1s) / Extend (+2s) / Reveal / Next.
3. **Participants** — Enter the code + name → guess in realtime → scores sync on host and players.

## Notes

- MP3s are stored in the database so they work locally and when published.
- Browsers may block autoplay until the player taps **Tap to enable sound**.
- Realtime sync uses Server-Sent Events; session state is persisted so a refresh can resume a live quiz.
