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
  it("preserves the v0.2.5 signed release bytes exactly", async () => {
    const [manifest, signature] = await Promise.all([
      readFile(stableAsset("manifest.json")),
      readFile(stableAsset("manifest.sig")),
    ]);

    expect(createHash("sha256").update(manifest).digest("hex")).toBe(
      "20a4793658bff750bbc739e064221ac105d7aa5a488f2ec3c0d38f03327aaa40",
    );
    expect(signature).toEqual(
      Buffer.from("hcQBHNXAcrp7b2rxhPKM5PcT/Xx22k5z559dHwHvwVJOTrjDdxSGT5URkwkcsdCxKO1FhntKAzCjWVLwbqYWDg==", "base64"),
    );
    expect(signature).toHaveLength(64);
    expect(verify(null, manifest, releasePublicKey, signature)).toBe(true);
  });

  it("pins the site-served installer bytes and its trust chain inputs", async () => {
    const bytes = await readFile(stableAsset("install.sh"));
    const installer = bytes.toString("utf8");

    expect(
      createHash("sha256").update(bytes).digest("hex"),
    ).toBe("5734c764bc87d4804aae5c027a60da3d154ea1954ef322fbb58ef11d383afde5");
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
