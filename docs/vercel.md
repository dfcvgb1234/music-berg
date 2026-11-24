# Deploy Bergs Music on Vercel

Next.js App Router app. Production **requires Postgres** (`DATABASE_URL`) — PGlite is local-only and will not persist across serverless invocations.

## One-time: claim or link a project

### Option A — claim the agent temporary deployment

If a temporary deploy was created for you, open the claim URL from the agent report, sign in to Vercel, and keep the project (suggested name: `berg-music` / `music-berg`).

### Option B — CLI (logged in)

```bash
# Install CLI if needed
npm i -g vercel

vercel login
vercel link --yes --project berg-music
# or create on first deploy:
vercel deploy --yes --prod --project berg-music --create-if-missing
```

Connect the GitHub repo `dfcvgb1234/music-berg` in the Vercel project **Settings → Git** so pushes to `main` (or your production branch) auto-deploy.

## Environment variables

Set these in **Project → Settings → Environment Variables** for Production (and Preview if you use preview deploys):

| Name | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | **Yes** | Postgres connection string (Vercel Postgres / Neon / any Postgres). Also set `DATABASE_URL_UNPOOLED` to the same (or unpooled) URL if your provider offers it — used by `scripts/migrate.mjs` at build. |
| `BERGS_MUSIC_UPLOAD_SECRET` | **Yes** (or legacy name) | Shared secret for creating track lists. Clients send it as header `x-upload-secret`. |
| `RIFFRUSH_UPLOAD_SECRET` | Legacy alias | Still accepted if `BERGS_MUSIC_UPLOAD_SECRET` is unset. |

Generate a strong secret, e.g. `openssl rand -hex 24`.

### Attach Postgres

1. Vercel dashboard → Storage → Create Database → Postgres (or Neon), **or**
2. Use any external Postgres and paste `DATABASE_URL`.

Migrations under `migrations/*.sql` run during `npm run build` via `scripts/migrate.mjs` when `DATABASE_URL` is set.

## Deploy commands

```bash
# Preview
vercel deploy --yes

# Production
vercel deploy --yes --prod
```

Or push to the connected Git branch.

## Local vs Vercel

| | Local | Vercel |
| --- | --- | --- |
| DB | PGlite (no `DATABASE_URL`) | Postgres required |
| Upload secret | Optional | Required (`BERGS_MUSIC_UPLOAD_SECRET` or `RIFFRUSH_UPLOAD_SECRET`) |
| Audio | Host browser only | Same — participants never get `/api/sessions/.../audio` |
| ffmpeg | Used when installed; byte-trim fallback otherwise | Usually no ffmpeg → byte-trim fallback for clips |

## After deploy

1. Open the production URL.
2. **Start new quiz** → create a track list with the upload secret.
3. Host plays clips; participants join by code and guess — they should **not** hear audio on their devices.
