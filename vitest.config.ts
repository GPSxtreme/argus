import { defineConfig } from "vitest/config";
import { fumadocsMdx } from "fumadocs-mdx/vite";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  plugins: [fumadocsMdx({ configPath: "apps/web/source.config.ts" })],
  test: {
    include: ["{apps,packages,test}/**/*.test.{ts,tsx}"],
  },
});
