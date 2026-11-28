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
| `R2_ACCOUNT_ID` | **Yes (production)** | Cloudflare account id for R2. Durable quiz audio is stored in R2 (not Neon bytea). |
| `R2_ACCESS_KEY_ID` | **Yes (with R2)** | R2 API token access key id. |
| `R2_SECRET_ACCESS_KEY` | **Yes (with R2)** | R2 API token secret. |
| `R2_BUCKET` | Optional | Defaults to `music-berg`. |
| `R2_PUBLIC_BASE_URL` | Optional | Custom/public base URL (no trailing slash). Used for CSP and optional public object URLs; DB stores private keys / `r2://` locators. |
| `BLOB_READ_WRITE_TOKEN` | Optional fallback | Legacy Vercel Blob client uploads (copied into R2 on save when R2 is configured). |
| `BLOB_STORE_ID` | Optional | Added automatically when a Blob store is connected via the dashboard. |
| `VERCEL_SUPPORT_LARGE_REQUEST_BODY` | Optional | Only helps on Pro/Enterprise with **Performance (4GB)** Function CPU (20 MiB body beta). **Hobby cannot use Performance**, so prefer R2 (or Blob) client uploads instead. |

Generate a strong secret, e.g. `openssl rand -hex 24`.

### Large uploads (Hobby / HTTP 413 fix)

Vercel Hobby rejects request bodies over ~4.5 MB (`FUNCTION_PAYLOAD_TOO_LARGE`). Local `next start` has no such cap.

**Preferred path (Hobby-safe):** Cloudflare R2 bucket `music-berg` with `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (and optional `R2_BUCKET` / `R2_PUBLIC_BASE_URL`).

1. Create an R2 bucket (name `music-berg`) and an API token with Object Read & Write.
2. Set the R2 env vars on the Vercel project (Production + Preview as needed).
3. Allow browser PUT from your app origin in the bucket **CORS** policy (`PUT`, `GET`, `HEAD`; expose `ETag`).
4. Redeploy.

Flow: browser crops + encodes each track to **Opus 96 kbps (Ogg)** via ffmpeg.wasm, requests a presigned PUT from `/api/r2/upload`, uploads to R2 under `songs/…` → `/api/templates` stores `r2_object_key` / `r2_object_url` in Postgres. Host playback (`/api/sessions/…/audio`) auth-gates then streams from R2. R2 is required for create/edit (no Postgres bytea). `postinstall`/`prebuild` copy ffmpeg UMD + wasm into `public/ffmpeg/` (gitignored).

### Verify R2 coverage / drop legacy bytea

```bash
npm run verify:r2-audio                       # all songs must have r2_object_key
npm run migrate:audio-data-to-r2              # dry-run (legacy; no-op if column dropped)
npm run migrate:audio-data-to-r2:execute      # upload stragglers + clear bytea
```

`migrations/010_drop_audio_data.sql` drops `songs.audio_data` after asserting every song has `r2_object_key`. Requires `DATABASE_URL` + R2 env vars in the shell / build environment.

### Migrate leftover Blob objects → R2

```bash
npm run migrate:blob-to-r2
npm run migrate:blob-to-r2:execute
```

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
