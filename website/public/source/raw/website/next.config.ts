import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        // `.ts` maps to video/mp2t in the standard MIME table — the raw
        // source endpoint must always serve plain text (agents + browsers)
        source: "/source/raw/:path*",
        headers: [{ key: "Content-Type", value: "text/plain; charset=utf-8" }],
      },
      {
        source: "/source/json/:path*",
        headers: [{ key: "Content-Type", value: "application/json; charset=utf-8" }],
      },
      {
        // the dir listings (tree.json is plain .json — default MIME is fine)
        source: "/source/dir.json",
        headers: [{ key: "Content-Type", value: "application/json; charset=utf-8" }],
      },
      {
        source: "/source/dir/:path*",
        headers: [{ key: "Content-Type", value: "application/json; charset=utf-8" }],
      },
    ]
  },
}

export default nextConfig
