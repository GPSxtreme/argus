import { createHash, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";
import { releasePublicKey } from "../lib/release-public-key";

const stableAsset = (name: "manifest.json" | "manifest.sig") =>
  resolve(process.cwd(), "apps/web/public/releases/stable", name);

describe("stable release artifacts", () => {
  it("preserves the v0.1.6 signed release bytes exactly", async () => {
    const [manifest, signature] = await Promise.all([
      readFile(stableAsset("manifest.json")),
      readFile(stableAsset("manifest.sig")),
    ]);

    expect(createHash("sha256").update(manifest).digest("hex")).toBe(
      "4dcc8a5d42675538732a793ee87e954ae34068f08c6a7d2ae6edda1636adc767",
    );
    expect(signature).toEqual(
      Buffer.from("/c+6DR6oWXqMnbnFQp50d/8uGO/woUIt41tpaBLY71TOjrR45r/Kw3mfxQN2z2MnimRZix/lhxde5Dvo54bBDQ==", "base64"),
    );
    expect(signature).toHaveLength(64);
    expect(verify(null, manifest, releasePublicKey, signature)).toBe(true);
  });

  it("serves the mutable stable files with explicit cache and content types", async () => {
    const rules = await nextConfig.headers?.();

    expect(rules).toEqual(
      expect.arrayContaining([
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
      ]),
    );
  });
});
