import { createHash, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderInstaller } from "@argus/release";
import nextConfig from "../next.config";
import { canonicalManifestUrl, installerOptions } from "../lib/distribution";
import { releasePublicKey } from "../lib/release-public-key";

const stableAsset = (name: "manifest.json" | "manifest.sig") =>
  resolve(process.cwd(), "apps/web/public/releases/stable", name);

describe("stable release artifacts", () => {
  it("preserves the v0.1.9 signed release bytes exactly", async () => {
    const [manifest, signature] = await Promise.all([
      readFile(stableAsset("manifest.json")),
      readFile(stableAsset("manifest.sig")),
    ]);

    expect(createHash("sha256").update(manifest).digest("hex")).toBe(
      "d385ac3cf77763b30c4192b28dc0f1d25bddd35df04fbd9071f63980da7a5fb3",
    );
    expect(signature).toEqual(
      Buffer.from("CgGjY7fVtbmDEw576BcYMsfIMBtl7uD1EEgzsRPNu2w4IdAQDCEmCsLZSaV8gdUqaY4gyMJVDL0BjZ9+0by0Dw==", "base64"),
    );
    expect(signature).toHaveLength(64);
    expect(verify(null, manifest, releasePublicKey, signature)).toBe(true);
  });

  it("pins the site-served installer bytes and its trust chain inputs", () => {
    const bytes = renderInstaller(installerOptions);
    expect(
      createHash("sha256").update(bytes).digest("hex"),
    ).toBe("91e3559f37084926fa30676f44e1da392e12da68d81530abeb9686f585e01080");
    expect(bytes).toContain(canonicalManifestUrl);
    expect(bytes).toContain(releasePublicKey);
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
