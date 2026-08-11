import { createHash, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderInstaller } from "@argus/release";
import { describe, expect, it } from "vitest";
import { canonicalManifestUrl, installerOptions } from "../lib/distribution";
import { releasePublicKey } from "../lib/release-public-key";
import nextConfig from "../next.config";

const stableAsset = (name: "manifest.json" | "manifest.sig") =>
  resolve(process.cwd(), "apps/web/public/releases/stable", name);

describe("stable release artifacts", () => {
  it("preserves the v0.1.13 signed release bytes exactly", async () => {
    const [manifest, signature] = await Promise.all([
      readFile(stableAsset("manifest.json")),
      readFile(stableAsset("manifest.sig")),
    ]);

    expect(createHash("sha256").update(manifest).digest("hex")).toBe(
      "9b3de3bc58efae3bc34f00e1634d27ea89b6aafde0ceafdddb86597dc0b4d19e",
    );
    expect(signature).toEqual(
      Buffer.from("WH10JXobYlqX19wVeJmDUJGUmgN+pZqDcKsaLVQ9VvkBWwrqscdNwKi7rmC/8kK/vinSRgEfuna0zGcG+2SCDQ==", "base64"),
    );
    expect(signature).toHaveLength(64);
    expect(verify(null, manifest, releasePublicKey, signature)).toBe(true);
  });

  it("pins the canonical installer bytes and its trust chain inputs", () => {
    const bytes = renderInstaller(installerOptions);
    expect(
      createHash("sha256").update(bytes).digest("hex"),
    ).toBe("ad692b12af0d85c6d91e9e695b0d6ebe9b8c6697304d58c1823b28e8b8782c18");
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
