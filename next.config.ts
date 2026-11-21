import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { join } from "path";

const { version } = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")) as { version: string };

const nextConfig: NextConfig = {
  // Pin the trace root to this checkout. Otherwise a lockfile in a parent
  // directory (e.g. a stray ~/package-lock.json) makes Next infer the home
  // directory as the workspace root, and build tracing walks every agent
  // store under it (~/.claude, ~/.codex, ~/.omp, …): thousands of files,
  // most of the build time, growing with each session.
  outputFileTracingRoot: __dirname,
  serverExternalPackages: [
    "@anthropic-ai/claude-agent-sdk",
    "@lydell/node-pty",
    "better-sqlite3",
    "undici",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
  ],
  allowedDevOrigins: ['192.168.*.*'],
  async headers() {
    return [
      {
        source: "/",
        headers: [
          { key: "Cache-Control", value: "private, no-cache, max-age=0, must-revalidate" },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
  },
};

export default nextConfig;
