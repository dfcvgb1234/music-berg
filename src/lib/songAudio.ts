import { contentDispositionForMime, detectAudioMime } from "@/lib/audioMime";
import {
  fetchR2Audio,
  getR2ObjectStream,
  r2UploadsEnabled,
} from "@/lib/r2";

export type SongAudioRow = {
  mime_type: string | null;
  r2_object_key: string | null;
  r2_object_url: string | null;
};

/**
 * Serve durable song audio after the caller has already authorized the request.
 * Streams from Cloudflare R2 when `r2_object_key` (or locator URL) is set.
 * Keeps host-only gating on this route (no permanent public redirect).
 */
export async function respondWithSongAudio(
  song: SongAudioRow,
): Promise<Response> {
  const mimeFallback = song.mime_type?.trim() || "audio/ogg";
  const r2Ref = song.r2_object_key?.trim() || song.r2_object_url?.trim() || "";

  if (r2Ref && r2UploadsEnabled()) {
    try {
      const streamed = await getR2ObjectStream(r2Ref);
      const mime = streamed.contentType || mimeFallback;
      const headers: Record<string, string> = {
        "Content-Type": mime,
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": contentDispositionForMime(mime),
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      };
      if (streamed.contentLength != null) {
        headers["Content-Length"] = String(streamed.contentLength);
      }
      return new Response(asyncIterableToReadableStream(streamed.body), {
        headers,
      });
    } catch {
      const buf = await fetchR2Audio(r2Ref);
      const mime = detectAudioMime(buf, mimeFallback);
      return new Response(new Uint8Array(buf), {
        headers: {
          "Content-Type": mime,
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": contentDispositionForMime(mime),
          "Content-Length": String(buf.byteLength),
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        },
      });
    }
  }

  return Response.json({ error: "Audio not found" }, { status: 404 });
}

function asyncIterableToReadableStream(
  source: AsyncIterable<Uint8Array>,
): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    async cancel() {
      if (typeof iterator.return === "function") {
        await iterator.return();
      }
    },
  });
}
