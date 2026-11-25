import { Readable } from "node:stream";
import { google, type drive_v3 } from "googleapis";
import { uploadLimits } from "@/lib/uploadLimits";

/**
 * Experiment: durable track audio in Google Drive (user's Google One via OAuth,
 * or a service account shared into a user-owned folder).
 *
 * Enable with AUDIO_STORAGE=drive plus OAuth *or* service-account credentials.
 * See docs/google-drive.md.
 */

export function driveAudioEnabled(): boolean {
  return (
    process.env.AUDIO_STORAGE?.trim().toLowerCase() === "drive" &&
    driveAuthConfigured()
  );
}

export function driveAuthConfigured(): boolean {
  return driveAuthMode() !== null;
}

type DriveAuthMode = "oauth" | "service_account";

function driveAuthMode(): DriveAuthMode | null {
  const oauth =
    Boolean(process.env.GOOGLE_DRIVE_CLIENT_ID?.trim()) &&
    Boolean(process.env.GOOGLE_DRIVE_CLIENT_SECRET?.trim()) &&
    Boolean(process.env.GOOGLE_DRIVE_REFRESH_TOKEN?.trim());
  if (oauth) return "oauth";

  const sa =
    Boolean(process.env.GOOGLE_DRIVE_CLIENT_EMAIL?.trim()) &&
    Boolean(process.env.GOOGLE_DRIVE_PRIVATE_KEY?.trim());
  if (sa) return "service_account";

  return null;
}

function privateKeyFromEnv(): string {
  const raw = process.env.GOOGLE_DRIVE_PRIVATE_KEY?.trim() ?? "";
  // Vercel/env UIs often store literal \n sequences.
  return raw.replace(/\\n/g, "\n");
}

async function getDrive(): Promise<drive_v3.Drive> {
  const mode = driveAuthMode();
  if (!mode) {
    throw new Error("Google Drive credentials are not configured");
  }

  if (mode === "oauth") {
    const oauth2 = new google.auth.OAuth2(
      process.env.GOOGLE_DRIVE_CLIENT_ID!.trim(),
      process.env.GOOGLE_DRIVE_CLIENT_SECRET!.trim(),
    );
    oauth2.setCredentials({
      refresh_token: process.env.GOOGLE_DRIVE_REFRESH_TOKEN!.trim(),
    });
    return google.drive({ version: "v3", auth: oauth2 });
  }

  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_DRIVE_CLIENT_EMAIL!.trim(),
    key: privateKeyFromEnv(),
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  });
  return google.drive({ version: "v3", auth });
}

function folderParents(): string[] | undefined {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID?.trim();
  return folderId ? [folderId] : undefined;
}

/** Upload audio bytes to Drive; returns the created file id. */
export async function uploadDriveAudio(opts: {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}): Promise<string> {
  if (opts.buffer.length <= 0) {
    throw new Error("Empty audio buffer");
  }
  if (opts.buffer.length > uploadLimits.maxFileBytes) {
    throw new Error("Audio exceeds size limit");
  }

  const drive = await getDrive();
  const res = await drive.files.create({
    requestBody: {
      name: opts.fileName,
      parents: folderParents(),
      mimeType: opts.mimeType,
    },
    media: {
      mimeType: opts.mimeType,
      body: Readable.from(opts.buffer),
    },
    fields: "id",
    supportsAllDrives: true,
  });

  const id = res.data.id?.trim();
  if (!id) throw new Error("Drive upload did not return a file id");
  return id;
}

/** Download a Drive file into a Buffer (server-side proxy for host playback). */
export async function fetchDriveAudio(fileId: string): Promise<Buffer> {
  const id = fileId.trim();
  if (!id || !/^[\w-]+$/.test(id)) {
    throw new Error("Invalid Drive file id");
  }

  const drive = await getDrive();
  const res = await drive.files.get(
    {
      fileId: id,
      alt: "media",
      supportsAllDrives: true,
    },
    { responseType: "arraybuffer" },
  );

  const data = res.data as ArrayBuffer | Buffer | Uint8Array | string;
  let buf: Buffer;
  if (Buffer.isBuffer(data)) {
    buf = data;
  } else if (data instanceof ArrayBuffer) {
    buf = Buffer.from(data);
  } else if (data instanceof Uint8Array) {
    buf = Buffer.from(data);
  } else if (typeof data === "string") {
    buf = Buffer.from(data, "binary");
  } else {
    throw new Error("Unexpected Drive download payload");
  }

  if (buf.length > uploadLimits.maxFileBytes) {
    throw new Error("Audio Drive file exceeds size limit");
  }
  return buf;
}

export async function deleteDriveQuiet(fileId: string): Promise<void> {
  try {
    const id = fileId.trim();
    if (!id) return;
    const drive = await getDrive();
    await drive.files.delete({ fileId: id, supportsAllDrives: true });
  } catch {
    // best-effort cleanup
  }
}
