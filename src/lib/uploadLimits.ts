/** App-level caps for template audio uploads (Opus clips / legacy MP3). */
export const uploadLimits = {
  maxFileBytes: 6 * 1024 * 1024,
  maxTemplates: 40,
  /**
   * Max sum of stored audio bytes per track list (no song-count cap).
   * Applies to encoded clips on create (client + server).
   */
  maxTemplateAudioBytes: 50 * 1024 * 1024,
  /**
   * Multipart request body ceiling (audio + form overhead). Kept at/above
   * maxTemplateAudioBytes for the local direct-upload path.
   */
  maxRequestBytes: 50 * 1024 * 1024,
} as const;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
