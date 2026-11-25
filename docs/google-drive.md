# Google Drive audio storage (experiment)

This branch can keep **durable track audio in Google Drive** (typically the host’s Google One quota) instead of Postgres `bytea`. The app still stores **Drive file IDs + song metadata** in Postgres. Host playback proxies bytes through `/api/sessions/[code]/audio` with Drive auth on the server — participants never get audio URLs.

Vercel Blob remains available as an optional **Hobby-safe staging** path (browser → Blob → server). When Drive is enabled, the server moves those bytes into Drive and does **not** keep `audio_data` in the DB.

## When to use this

| Goal | Setting |
| --- | --- |
| Experiment / avoid large `bytea` | `AUDIO_STORAGE=drive` + Drive credentials |
| Existing behavior (Blob → Postgres, or multipart → Postgres) | Leave `AUDIO_STORAGE` unset (or set to anything other than `drive`) |

Without `AUDIO_STORAGE=drive`, the app behaves like `main`: Blob staging when `BLOB_READ_WRITE_TOKEN` is set, otherwise direct multipart into Postgres.

## Environment variables

Set these in **Project → Settings → Environment Variables** (or `.env.local` for local runs).

| Name | Required for Drive | Notes |
| --- | --- | --- |
| `AUDIO_STORAGE` | **Yes** (`drive`) | Feature flag. Must be exactly `drive` (case-insensitive) to enable. |
| `GOOGLE_DRIVE_FOLDER_ID` | Recommended | Folder in the user’s Drive where clips are created. Create a folder in Drive → share if using a service account → copy the id from the URL (`…/folders/<id>`). |
| `BLOB_READ_WRITE_TOKEN` | Optional | Still recommended on Vercel Hobby so the browser uploads to Blob first; the server then copies into Drive. Without Blob, create uses multipart → Drive (local / larger body limits). |

### Option A — OAuth (preferred for “my Google One”)

Use a Google Cloud **OAuth desktop or web client** owned by you, authorize once, and store the refresh token on the server.

| Name | Required |
| --- | --- |
| `GOOGLE_DRIVE_CLIENT_ID` | Yes |
| `GOOGLE_DRIVE_CLIENT_SECRET` | Yes |
| `GOOGLE_DRIVE_REFRESH_TOKEN` | Yes |

**Setup outline**

1. [Google Cloud Console](https://console.cloud.google.com/) → create/select a project.
2. Enable **Google Drive API**.
3. APIs & Services → Credentials → **Create credentials → OAuth client ID**  
   - Application type: **Desktop app** (simplest for a one-time refresh token) or Web application.
4. OAuth consent screen: External (or Internal for Workspace). Add yourself as a test user while in Testing.
5. Obtain a refresh token with the Drive file scope, e.g. with [`gcloud` / oauth playground](https://developers.google.com/oauthplayground/) or a tiny local script:

   Scope: `https://www.googleapis.com/auth/drive.file`

   OAuth Playground: gear icon → “Use your own OAuth credentials” → authorize **Drive API v3** → `drive.file` → Exchange authorization code for tokens → copy **Refresh token**.

6. Set `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`, `GOOGLE_DRIVE_REFRESH_TOKEN`, `AUDIO_STORAGE=drive`, and ideally `GOOGLE_DRIVE_FOLDER_ID`.
7. Redeploy / restart `next dev`.

Files created with the user’s refresh token count against **that Google account’s** storage (Google One).

### Option B — Service account

| Name | Required |
| --- | --- |
| `GOOGLE_DRIVE_CLIENT_EMAIL` | Yes |
| `GOOGLE_DRIVE_PRIVATE_KEY` | Yes (full PEM; use `\n` for newlines in env UIs) |

**Setup outline**

1. Google Cloud → IAM → Service accounts → Create → key type JSON.
2. Enable **Google Drive API** on the project.
3. In Drive, create a folder, **Share** it with the service account email (**Editor**).
4. Set `GOOGLE_DRIVE_CLIENT_EMAIL`, `GOOGLE_DRIVE_PRIVATE_KEY` (paste the `private_key` value), `GOOGLE_DRIVE_FOLDER_ID`, `AUDIO_STORAGE=drive`.

**Caveat:** files created by a service account are owned by the SA by default and use the SA’s Drive quota (not the user’s Google One), unless you use domain-wide delegation or OAuth (Option A). Prefer OAuth for personal Google One experiments.

## Runtime flow

1. Host UI encodes Opus clips (unchanged).
2. **Transport** (unchanged selection):
   - `BLOB_READ_WRITE_TOKEN` set → browser uploads to private Blob → `POST /api/templates` JSON with `blobUrl`s.
   - else → multipart `POST /api/templates` with file bytes.
3. **Durable store** when `AUDIO_STORAGE=drive` and credentials are present:
   - Server reads bytes (from Blob or multipart).
   - Uploads to Drive (`drive.files.create`), stores `songs.drive_file_id`, leaves `audio_data` null.
   - Deletes staging Blob objects (best-effort).
4. Host Play/Reveal: `GET /api/sessions/[code]/audio` with `x-host-token` → if `drive_file_id` is set, server downloads from Drive and returns the bytes; otherwise uses `audio_data`.

`GET /api/upload-mode` reports:

```json
{
  "mode": "blob",
  "transport": "blob",
  "storage": "drive",
  "drive": true
}
```

(`mode` is kept for older clients; prefer `transport` + `storage`.)

## Migration

`migrations/007_drive_audio.sql` adds nullable `songs.drive_file_id` and drops `NOT NULL` on `audio_data`. It runs with `npm run build` / `scripts/migrate.mjs` when `DATABASE_URL` is set, and automatically for local PGlite on first query.

## Local test checklist

1. Set OAuth (or SA) env vars + `AUDIO_STORAGE=drive` + folder id.
2. `npm run dev` → Start new quiz → create a short track list.
3. Confirm a new file appears in the Drive folder.
4. Confirm Postgres row has `drive_file_id` and null/`empty` `audio_data`.
5. Host Play: audio still plays (proxied).

## Security notes

- Never commit client secrets, refresh tokens, or private keys.
- Host audio remains gated by `x-host-token`; Drive file IDs are not exposed to participants.
- Scope should stay at `drive.file` (files created by the app), not full Drive access, when using OAuth.
- Rotate refresh tokens / SA keys if leaked.

## Rollback

Unset `AUDIO_STORAGE` (or set it to `postgres`) and redeploy. Existing Drive-backed songs still need Drive credentials to play; new creates go back to Postgres `bytea` (and Blob staging when configured).
