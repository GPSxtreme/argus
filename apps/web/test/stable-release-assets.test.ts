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
  it("preserves the v0.2.4 signed release bytes exactly", async () => {
    const [manifest, signature] = await Promise.all([
      readFile(stableAsset("manifest.json")),
      readFile(stableAsset("manifest.sig")),
    ]);

    expect(createHash("sha256").update(manifest).digest("hex")).toBe(
      "47916273134f96fa5cc7f40bc5626367a4bc8d85fbdec5f62f8837d248060843",
    );
    expect(signature).toEqual(
      Buffer.from("hMBTA/8NFqtM/F8WNIL18sGyp3nV41C65HuIuQCFbsuovwiOZ1dufyBYFf3Vz5LFzHM3bT3N/u3BOjxHG/UwDg==", "base64"),
    );
    expect(signature).toHaveLength(64);
    expect(verify(null, manifest, releasePublicKey, signature)).toBe(true);
  });

  it("pins the site-served installer bytes and its trust chain inputs", async () => {
    const bytes = await readFile(stableAsset("install.sh"));
    const installer = bytes.toString("utf8");

    expect(
      createHash("sha256").update(bytes).digest("hex"),
    ).toBe("9cd0c15ca93242a91fb53181a2518946fb4e7a6b79bedc5a3f30074be2a55234");
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
