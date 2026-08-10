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
  it("preserves every v0.1.13 stable bundle member exactly", async () => {
    const [installer, manifest, signature] = await Promise.all([
      readFile(stableAsset("install.sh")),
      readFile(stableAsset("manifest.json")),
      readFile(stableAsset("manifest.sig")),
    ]);

    expect(createHash("sha256").update(installer).digest("hex")).toBe(
      "91e3559f37084926fa30676f44e1da392e12da68d81530abeb9686f585e01080",
    );
    expect(createHash("sha256").update(manifest).digest("hex")).toBe(
      "9b3de3bc58efae3bc34f00e1634d27ea89b6aafde0ceafdddb86597dc0b4d19e",
    );
    expect(createHash("sha256").update(signature).digest("hex")).toBe(
      "57b812a2e016af924f537fd4d903e203f3a01487b65632ede90380a05363c69c",
    );
    expect(signature).toEqual(
      Buffer.from("WH10JXobYlqX19wVeJmDUJGUmgN+pZqDcKsaLVQ9VvkBWwrqscdNwKi7rmC/8kK/vinSRgEfuna0zGcG+2SCDQ==", "base64"),
    );
    expect(signature).toHaveLength(64);
    expect(verify(null, manifest, releasePublicKey, signature)).toBe(true);
  });

  it("binds the pinned installer to the signed v0.1.13 legacy wrapper contract", async () => {
    const [bytes, manifestBytes] = await Promise.all([
      readFile(stableAsset("install.sh")),
      readFile(stableAsset("manifest.json")),
    ]);
    const installer = bytes.toString("utf8");
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
      assets: { wrapper: { sha256: string; url: string } };
    };

    expect(installer).toContain(canonicalManifestUrl);
    expect(installer).toContain(releasePublicKey);
    expect(manifest.assets.wrapper).toEqual({
      url: "https://github.com/GPSxtreme/argus/releases/download/v0.1.13/argus",
      sha256: "5c6e2cac012d402d805a176abb1b8134f3f32f34efb97b7d4400680eb663da71",
    });
    expect(installer).toContain("argus_is_wrapper() {");
    expect(installer).toContain("# argus-host-wrapper schema=1");
    expect(installer).toContain(
      'argus_die "signed wrapper is not a recognizable Argus host command"',
    );
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
