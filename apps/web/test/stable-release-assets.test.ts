import { createHash, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalManifestUrl } from "../lib/distribution";
import { releasePublicKey } from "../lib/release-public-key";
import nextConfig from "../next.config";

const stableAsset = (name: "install.sh" | "manifest.json" | "manifest.sig") =>
  resolve(process.cwd(), "apps/web/public/releases/stable", name);

describe("stable release artifacts", () => {
  it("preserves the v0.2.6 signed release bytes exactly", async () => {
    const [manifest, signature] = await Promise.all([
      readFile(stableAsset("manifest.json")),
      readFile(stableAsset("manifest.sig")),
    ]);

    expect(createHash("sha256").update(manifest).digest("hex")).toBe(
      "35d9eeb8da1799ed75a06b41dbf756f977b795be5c473ed770ba6a6e009b74d1",
    );
    expect(signature).toEqual(
      Buffer.from("KE+Hv88Jv1ebjPiiY6hHn+9TsvrTudWqhXkobb1Sb+m0BAu4tPQogLqeVpKe1DrSDhYfKJA0qIFV5IYWBTX/DA==", "base64"),
    );
    expect(signature).toHaveLength(64);
    expect(verify(null, manifest, releasePublicKey, signature)).toBe(true);
  });

  it("pins the site-served installer bytes and its trust chain inputs", async () => {
    const bytes = await readFile(stableAsset("install.sh"));
    const installer = bytes.toString("utf8");

    expect(
      createHash("sha256").update(bytes).digest("hex"),
    ).toBe("e7c41a3ab9396e331e18bac50ba8f66971d9a7a5b29b8b3de57866b89bf37a1b");
    expect(installer).toContain(canonicalManifestUrl);
    expect(installer).toContain(releasePublicKey);
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
