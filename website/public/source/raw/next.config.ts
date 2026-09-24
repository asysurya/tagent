import path from "node:path";
import type { NextConfig } from "next";

// TAGENT_EXPORT=1 → static export into out/, later moved to gui-dist/ and
// served by the Tagent daemon itself (single-process local install).
// Default (no env) → standalone build for the sandbox harness.
const isExport = !!process.env.TAGENT_EXPORT;

const nextConfig: NextConfig = {
  ...(isExport
    ? { output: "export" as const, images: { unoptimized: true } }
    : { output: "standalone" as const }),
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
