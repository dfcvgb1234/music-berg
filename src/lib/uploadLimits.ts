/** Keep under common reverse-proxy body caps (~1MiB). */
export const uploadLimits = {
  maxFileBytes: 700 * 1024,
  maxSongsPerTemplate: 6,
  maxTemplates: 40,
  maxRequestBytes: 900 * 1024,
} as const;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
