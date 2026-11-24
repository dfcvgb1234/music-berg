# Deploy Bergs Music on Vercel

Next.js App Router app. Production **requires Postgres** (`DATABASE_URL`) — PGlite is local-only and will not persist across serverless invocations.

Production URL (example): `https://bergs-music.vercel.app`

## Environment variables

Set these in **Project → Settings → Environment Variables** for Production (and Preview if you use preview deploys):

| Name | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | **Yes** | Postgres connection string (Vercel Postgres / Neon / any Postgres). Also set `DATABASE_URL_UNPOOLED` to the same (or unpooled) URL if your provider offers it — used by `scripts/migrate.mjs` at build. |
| `BERGS_MUSIC_UPLOAD_SECRET` | **Yes** (or legacy name) | Shared secret for creating track lists. Clients send it as header `x-upload-secret`. |
| `RIFFRUSH_UPLOAD_SECRET` | Legacy alias | Still accepted if `BERGS_MUSIC_UPLOAD_SECRET` is unset. |
| `BLOB_READ_WRITE_TOKEN` | **Yes (Hobby-safe uploads)** | Read-write token for private Blob store (e.g. `bergs-music-audio`). Enables browser → Blob uploads so `/api/templates` only receives small JSON (avoids the ~4.5 MB function body cap on Hobby). |
| `BLOB_STORE_ID` | Optional | Added automatically when the Blob store is connected via the dashboard. |
| `VERCEL_SUPPORT_LARGE_REQUEST_BODY` | Optional | Only helps on Pro/Enterprise with **Performance (4GB)** Function CPU (20 MiB body beta). **Hobby cannot use Performance**, so prefer Blob uploads instead. |

Generate a strong secret, e.g. `openssl rand -hex 24`.

### Large uploads (Hobby / HTTP 413 fix)

Vercel Hobby rejects request bodies over ~4.5 MB (`FUNCTION_PAYLOAD_TOO_LARGE`). Local `next start` has no such cap.

**Preferred path (Hobby-safe):** connect a **private** Vercel Blob store and set `BLOB_READ_WRITE_TOKEN`.

1. Create/connect private Blob store `bergs-music-audio` to project `bergs-music`.
2. Ensure the connection includes a **read-write token** env var (`BLOB_READ_WRITE_TOKEN`).
3. Redeploy.

Flow: browser uploads each MP3 directly to Blob (`/api/blob/upload` token exchange) → `/api/templates` receives JSON with Blob URLs → server pulls bytes from Blob into Postgres. Without `BLOB_READ_WRITE_TOKEN`, the UI falls back to multipart POST (fine locally; will 413 on Hobby for ~5MB files).

### Attach Postgres

1. Vercel dashboard → Storage → Create Database → Postgres (or Neon), **or**
2. Use any external Postgres and paste `DATABASE_URL`.

Migrations under `migrations/*.sql` run during `npm run build` via `scripts/migrate.mjs` when `DATABASE_URL` is set.

## Deploy

Push to the Git branch connected to the Vercel project, or:

```bash
vercel deploy --yes --prod
```

## Local vs Vercel

| | Local | Vercel |
| --- | --- | --- |
| DB | PGlite (no `DATABASE_URL`) | Postgres required |
| Upload secret | Optional | Required (`BERGS_MUSIC_UPLOAD_SECRET` or `RIFFRUSH_UPLOAD_SECRET`) |
| Request body | No 4.5 MB platform cap | Needs `VERCEL_SUPPORT_LARGE_REQUEST_BODY=1` + Performance memory for >4.5 MB |
| Audio | Host browser only | Same — participants never get `/api/sessions/.../audio` |
| Host audio | Full MP3 + client stop timer | Same — no server-side clip trim (avoids broken MP3s without ffmpeg) |

## After deploy

1. Open the production URL.
2. **Start new quiz** → create a track list with the upload secret.
3. Host plays clips; participants join by code and guess — they should **not** hear audio on their devices.
