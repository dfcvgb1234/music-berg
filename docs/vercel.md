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
| `VERCEL_SUPPORT_LARGE_REQUEST_BODY` | **Yes for ~5MB+ uploads** | Set to `1`. Raises the Vercel Function request body cap from **4.5 MB → 20 MiB** (public beta). Without this, template create returns **HTTP 413** for typical MP3s. |

Generate a strong secret, e.g. `openssl rand -hex 24`.

### Large uploads (HTTP 413 fix)

Vercel rejects bodies over ~4.5 MB before Next.js runs (`FUNCTION_PAYLOAD_TOO_LARGE`). Local `next start` has no such cap, which is why uploads work locally.

To allow ~5 MB (and multi-song) template creates:

1. Enable **Fluid compute** (default on new projects).
2. Set **Function CPU → Performance (4 GB / 2 vCPU)** in Project → Settings → Functions (Pro/Enterprise; required for the 20 MiB body beta).
3. Set env `VERCEL_SUPPORT_LARGE_REQUEST_BODY=1` for Production (and Preview if needed).
4. Redeploy.

Repo already sets Next.js `experimental.proxyClientMaxBodySize` / `serverActions.bodySizeLimit` to `50mb`, `runtime = "nodejs"` + `maxDuration = 60` on `/api/templates`, and `vercel.json` function `maxDuration`.

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
| ffmpeg | Used when installed; byte-trim fallback otherwise | Usually no ffmpeg → byte-trim fallback for clips |

## After deploy

1. Open the production URL.
2. **Start new quiz** → create a track list with the upload secret.
3. Host plays clips; participants join by code and guess — they should **not** hear audio on their devices.
