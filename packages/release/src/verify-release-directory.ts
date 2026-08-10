import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  verifyReleaseManifestWithIdentity,
  type VerifiedReleaseManifest,
} from "./manifest.js";

export interface VerifiedReleaseDirectory {
  release: VerifiedReleaseManifest;
  publicKeyPem: string;
}

const signedAssets = [
  ["fxembed", "fxembed.js"],
  ["wrapper", "argus"],
  ["installer", "install.sh"],
  ["publicKey", "release-public.pem"],
  ["fxembedLicense", "FXEMBED-LICENSE.md"],
  ["fxembedProvenance", "fxembed-provenance.json"],
] as const;

/** Verifies every byte whose identity is signed by a release manifest. */
export const verifyReleaseDirectory = async (
  directory: string,
  publicKeyPath?: string,
): Promise<VerifiedReleaseDirectory> => {
  const releaseDirectory = resolve(directory);
  const candidatePublicKeyPath = join(releaseDirectory, "release-public.pem");
  const verificationPublicKeyPath = resolve(publicKeyPath ?? candidatePublicKeyPath);
  const [manifestBytes, signature, publicKeyPem] = await Promise.all([
    readFile(join(releaseDirectory, "manifest.json")),
    readFile(join(releaseDirectory, "manifest.sig")),
    readFile(verificationPublicKeyPath, "utf8"),
  ]);
  const release = verifyReleaseManifestWithIdentity(
    manifestBytes,
    signature,
    publicKeyPem,
  );
  await Promise.all(
    signedAssets.map(async ([assetName, filename]) => {
      const asset = release.manifest.assets[assetName];
      if (asset === undefined) {
        throw new TypeError(
          `Signed manifest is missing ${assetName} checksum coverage.`,
        );
      }
      const bytes = await readFile(join(releaseDirectory, filename));
      const checksum = createHash("sha256").update(bytes).digest("hex");
      if (checksum !== asset.sha256) {
        throw new TypeError(`Signed checksum mismatch for ${filename}.`);
      }
    }),
  );
  return { release, publicKeyPem };
};
