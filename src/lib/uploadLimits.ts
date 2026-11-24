/** App-level caps for template MP3 uploads (several ~5MB songs). */
export const uploadLimits = {
  maxFileBytes: 6 * 1024 * 1024,
  maxSongsPerTemplate: 8,
  maxTemplates: 40,
  /** Comfortably fits several 5–6MB tracks plus multipart overhead. */
  maxRequestBytes: 48 * 1024 * 1024,
} as const;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
