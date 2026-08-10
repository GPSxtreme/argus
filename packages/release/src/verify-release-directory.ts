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
  ["fxembedLicense", "FXEMBED-LICENSE.md"],
  ["fxembedProvenance", "fxembed-provenance.json"],
] as const;

export interface ReleaseVerificationIO {
  readFile(path: string): Promise<Buffer>;
}

export interface VerifyReleaseFilesOptions {
  releaseDirectory: string;
  manifestPath: string;
  signaturePath: string;
  verificationPublicKeyPath?: string;
}

const nodeReleaseVerificationIO: ReleaseVerificationIO = {
  async readFile(path) {
    return readFile(path);
  },
};

export const verifyReleaseFiles = async (
  options: VerifyReleaseFilesOptions,
  io: ReleaseVerificationIO = nodeReleaseVerificationIO,
): Promise<VerifiedReleaseDirectory> => {
  const releaseDirectory = resolve(options.releaseDirectory);
  const candidatePublicKeyPath = join(releaseDirectory, "release-public.pem");
  const verificationPublicKeyPath = resolve(
    options.verificationPublicKeyPath ?? candidatePublicKeyPath,
  );
  const [manifestBytes, signature, candidatePublicKeyBytes] = await Promise.all([
    io.readFile(resolve(options.manifestPath)),
    io.readFile(resolve(options.signaturePath)),
    io.readFile(candidatePublicKeyPath),
  ]);
  const publicKeyPem = candidatePublicKeyBytes.toString("utf8");
  const release = verifyReleaseManifestWithIdentity(
    manifestBytes,
    signature,
    publicKeyPem,
  );
  if (verificationPublicKeyPath !== candidatePublicKeyPath) {
    const verificationPublicKeyPem = (
      await io.readFile(verificationPublicKeyPath)
    ).toString("utf8");
    verifyReleaseManifestWithIdentity(
      manifestBytes,
      signature,
      verificationPublicKeyPem,
    );
  }
  const candidatePublicKeySha256 = createHash("sha256")
    .update(candidatePublicKeyBytes)
    .digest("hex");
  if (candidatePublicKeySha256 !== release.manifest.assets.publicKey.sha256) {
    throw new TypeError("Signed checksum mismatch for release-public.pem.");
  }
  await Promise.all(
    signedAssets.map(async ([assetName, filename]) => {
      const asset = release.manifest.assets[assetName];
      if (asset === undefined) {
        throw new TypeError(
          `Signed manifest is missing ${assetName} checksum coverage.`,
        );
      }
      const bytes = await io.readFile(join(releaseDirectory, filename));
      const checksum = createHash("sha256").update(bytes).digest("hex");
      if (checksum !== asset.sha256) {
        throw new TypeError(`Signed checksum mismatch for ${filename}.`);
      }
    }),
  );
  return { release, publicKeyPem };
};

/** Verifies every byte whose identity is signed by a release manifest. */
export const verifyReleaseDirectory = async (
  directory: string,
  publicKeyPath?: string,
  io: ReleaseVerificationIO = nodeReleaseVerificationIO,
): Promise<VerifiedReleaseDirectory> => {
  const releaseDirectory = resolve(directory);
  return verifyReleaseFiles(
    {
      releaseDirectory,
      manifestPath: join(releaseDirectory, "manifest.json"),
      signaturePath: join(releaseDirectory, "manifest.sig"),
      ...(publicKeyPath === undefined
        ? {}
        : { verificationPublicKeyPath: publicKeyPath }),
    },
    io,
  );
};
