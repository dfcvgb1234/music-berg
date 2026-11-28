import type { NextConfig } from "next";

function r2ConnectSrcExtra(): string {
  const parts = ["https://*.r2.cloudflarestorage.com"];
  const publicBase = process.env.R2_PUBLIC_BASE_URL?.trim();
  if (publicBase) {
    try {
      parts.push(new URL(publicBase).origin);
    } catch {
      // ignore invalid public base at build time
    }
  }
  return parts.join(" ");
}

const nextConfig: NextConfig = {
  serverExternalPackages: ["@electric-sql/pglite"],
  // Allow large multipart bodies for template MP3 uploads (Node route handlers /
  // proxy buffering). Vercel still needs VERCEL_SUPPORT_LARGE_REQUEST_BODY=1
  // + Performance (4GB) function memory for bodies above ~4.5MB — see docs/vercel.md.
  experimental: {
    proxyClientMaxBodySize: "50mb",
    serverActions: {
      bodySizeLimit: "50mb",
    },
  },
  async headers() {
    const connectExtra = r2ConnectSrcExtra();
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Content-Security-Policy",
            // wasm-unsafe-eval + blob workers: client ffmpeg.wasm Opus encode on upload.
            // R2: browser PUTs to *.r2.cloudflarestorage.com (and optional custom domain).
            value:
              `default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https://*.mzstatic.com https://*.dzcdn.net; media-src 'self' blob: https://*.dzcdn.net ${connectExtra}; connect-src 'self' blob: https://*.blob.vercel-storage.com https://vercel.com ${connectExtra}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
