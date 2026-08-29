import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  outputFileTracingIncludes: {
    "/skill/SKILL.md": ["../../skills/argus-setup/**/*"],
    "/skill/argus-skill.zip": ["../../skills/argus-setup/**/*"],
    "/skill/research/SKILL.md": ["../../skills/argus-research/**/*"],
    "/skill/argus-research.zip": ["../../skills/argus-research/**/*"],
  },
  webpack(config) {
    // The release package is authored as Node ESM, whose source imports retain
    // `.js` extensions. Map those imports back to their TypeScript sources when
    // Next bundles the route handlers.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };

    return config;
  },
  async headers() {
    return [
      {
        source: "/releases/stable/manifest.json",
        headers: [
          { key: "Cache-Control", value: "public, max-age=300, stale-while-revalidate=3600" },
          { key: "Content-Type", value: "application/json; charset=utf-8" },
        ],
      },
      {
        source: "/releases/stable/manifest.sig",
        headers: [
          { key: "Cache-Control", value: "public, max-age=300, stale-while-revalidate=3600" },
          { key: "Content-Type", value: "application/octet-stream" },
        ],
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: "/docs/:path*.md",
        destination: "/llms.mdx/docs/:path*",
      },
    ];
  },
};

export default createMDX()(nextConfig);
