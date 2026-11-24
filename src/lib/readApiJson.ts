/** Parse API JSON safely; surface plain-text proxy errors (e.g. 413). */
export async function readApiJson<T = { error?: string }>(
  res: Response,
): Promise<T> {
  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error(
      res.ok ? "Empty response" : `Request failed (${res.status})`,
    );
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const lower = trimmed.toLowerCase();
    if (
      res.status === 413 ||
      lower.includes("request entity too large") ||
      lower.startsWith("request en")
    ) {
      throw new Error(
        "Upload too large for the server. Use shorter/smaller MP3s (under ~700KB each, ~900KB total).",
      );
    }
    const snippet = trimmed.replace(/\s+/g, " ").slice(0, 120);
    throw new Error(
      res.ok
        ? `Unexpected response: ${snippet}`
        : `Request failed (${res.status}): ${snippet}`,
    );
  }
}
