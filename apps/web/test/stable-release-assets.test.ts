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
  it("preserves the v0.1.11 signed release bytes exactly", async () => {
    const [manifest, signature] = await Promise.all([
      readFile(stableAsset("manifest.json")),
      readFile(stableAsset("manifest.sig")),
    ]);

    expect(createHash("sha256").update(manifest).digest("hex")).toBe(
      "ebd16c63050e0a7daefd4590fe08a39e412a9e58f2a928f92489630fb15aa532",
    );
    expect(signature).toEqual(
      Buffer.from("xy5SBP5iD/jp1ihvBpfBTxmGgZ/qn6FtJkPWqswtkZ+wKHEG8k+DflbQTP4GkPdZ+tGLE63S83zoVtcrO1KwDw==", "base64"),
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
