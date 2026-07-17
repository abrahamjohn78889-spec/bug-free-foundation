/** @type {import('next').NextConfig} */
const nextConfig = {
  // Native/Node-only packages must NOT be bundled into .next/server chunks.
  // better-sqlite3 ships a compiled .node binding whose path resolution breaks
  // when bundled (the exact "tries: [...better_sqlite3.node]" crash in pm2 logs),
  // which made every /api/*/bot/status call return 500 in production builds.
  serverExternalPackages: ["better-sqlite3", "ws"],
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
