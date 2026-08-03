import { createHash, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";
import { releasePublicKey } from "../lib/release-public-key";

const stableAsset = (name: "manifest.json" | "manifest.sig") =>
  resolve(process.cwd(), "apps/web/public/releases/stable", name);

describe("stable release artifacts", () => {
  it("preserves the v0.1.7 signed release bytes exactly", async () => {
    const [manifest, signature] = await Promise.all([
      readFile(stableAsset("manifest.json")),
      readFile(stableAsset("manifest.sig")),
    ]);

    expect(createHash("sha256").update(manifest).digest("hex")).toBe(
      "0db584946a2b8dd814201919b43d26f8d62a9e8df79ee62b68f8df018587acb7",
    );
    expect(signature).toEqual(
      Buffer.from("JDCVJpdOQw0MQtbBZGWAk0sXREV3dslCjRnlMcsQl5p0p/3IVbNgNzfh0lRD9HzViJyZ5IFOOXIN1ffjssXEAg==", "base64"),
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
