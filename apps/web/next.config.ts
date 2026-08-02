import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  outputFileTracingIncludes: {
    "/skill/SKILL.md": ["../../skills/argus-setup/**/*"],
    "/skill/argus-skill.zip": ["../../skills/argus-setup/**/*"],
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
