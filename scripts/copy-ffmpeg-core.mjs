import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const destDir = join(root, "public", "ffmpeg");
mkdirSync(destDir, { recursive: true });

function pkgFile(specifier, relativePath) {
  let resolved;
  try {
    resolved = require.resolve(specifier);
  } catch (err) {
    console.warn(
      `[copy-ffmpeg-core] ${specifier} not installed — skip (${err instanceof Error ? err.message : err})`,
    );
    return null;
  }
  // specifier may resolve to a nested file; walk up to package root via node_modules path.
  const marker = join("node_modules", specifier.replace(/\//g, "/"));
  const idx = resolved.lastIndexOf(marker);
  const pkgRoot =
    idx >= 0
      ? resolved.slice(0, idx + marker.length)
      : dirname(resolved);
  return join(pkgRoot, relativePath);
}

// util UMD from @ffmpeg/util is broken in browsers (CJS `exports` leak) —
// client code inlines fetchFile/toBlobURL instead.
const copies = [
  ["@ffmpeg/core", "dist/umd/ffmpeg-core.js", "ffmpeg-core.js"],
  ["@ffmpeg/core", "dist/umd/ffmpeg-core.wasm", "ffmpeg-core.wasm"],
  ["@ffmpeg/ffmpeg", "dist/umd/ffmpeg.js", "ffmpeg.js"],
  // Worker chunk referenced at runtime by ffmpeg.js (same directory).
  ["@ffmpeg/ffmpeg", "dist/umd/814.ffmpeg.js", "814.ffmpeg.js"],
];

let ok = 0;
for (const [pkg, rel, destName] of copies) {
  const from = pkgFile(pkg, rel);
  if (!from) continue;
  if (!existsSync(from)) {
    console.error(`[copy-ffmpeg-core] missing ${from}`);
    process.exit(1);
  }
  copyFileSync(from, join(destDir, destName));
  console.log(`[copy-ffmpeg-core] ${destName}`);
  ok += 1;
}

if (ok === 0) {
  console.warn("[copy-ffmpeg-core] nothing copied");
}
