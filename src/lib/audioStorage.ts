import { blobUploadsEnabled } from "@/lib/blobAudio";
import { driveAudioEnabled } from "@/lib/driveAudio";

/** How the browser ships bytes to the server (staging / request path). */
export type UploadTransport = "blob" | "direct";

/**
 * Where durable track audio lives after template create.
 * - drive: Google Drive file IDs in DB (experiment)
 * - postgres: audio_data bytea (existing default)
 */
export type DurableAudioStorage = "drive" | "postgres";

export function durableAudioStorage(): DurableAudioStorage {
  return driveAudioEnabled() ? "drive" : "postgres";
}

export function uploadTransport(): UploadTransport {
  return blobUploadsEnabled() ? "blob" : "direct";
}

/** Public shape for /api/upload-mode (host UI). */
export function uploadModePayload() {
  return {
    /** @deprecated Prefer `transport` — kept for older clients. */
    mode: uploadTransport(),
    transport: uploadTransport(),
    storage: durableAudioStorage(),
    drive: driveAudioEnabled(),
  };
}
