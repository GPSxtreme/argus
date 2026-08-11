import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { renderInstaller } from "./installer.js";
import { verifyReleaseManifestWithIdentity } from "./manifest.js";
import { stableReleasePublicKey } from "./stable-trust-root.js";
import { verifyReleaseDirectoryWithPublicKey } from "./verify-release-directory.js";
import { renderArgusWrapper } from "./wrapper.js";

const stableManifestUrl =
  "https://argus.gpsxtre.me/releases/stable/manifest.json";

export interface StableBundlePromotion {
  version: string;
  manifestSha256: string;
  installerSha256: string;
}

export interface StableBundlePromotionOptions {
  /** Injectable filesystem boundary for promotion verification and recovery tests. */
  io?: StableBundleIO;
  /** Explicit root for controlled key rotation or isolated verification tests. */
  trustedPublicKeyPem?: string;
}

/** Injectable filesystem boundary for exercising promotion verification and recovery. */
export interface StableBundleIO {
  readFile(path: string): Promise<Buffer>;
  mkdir(directory: string): Promise<void>;
  writeFileAndSync(path: string, bytes: Uint8Array, mode: number): Promise<void>;
  syncDirectory(directory: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  removeDirectory(directory: string): Promise<void>;
  directoryExists(directory: string): Promise<boolean>;
}

const isMissing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

const nodeStableBundleIO: StableBundleIO = {
  async readFile(path) {
    return readFile(path);
  },
  async mkdir(directory) {
    await mkdir(directory, { mode: 0o700 });
  },
  async writeFileAndSync(path, bytes, mode) {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  async syncDirectory(directory) {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  async rename(from, to) {
    await rename(from, to);
  },
  async removeDirectory(directory) {
    await rm(directory, { recursive: true, maxRetries: 3 });
  },
  async directoryExists(directory) {
    try {
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new TypeError(`${directory} must be a real directory.`);
      }
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  },
};

export const createStableBundleIO = (
  overrides: Partial<StableBundleIO> = {},
): StableBundleIO => ({ ...nodeStableBundleIO, ...overrides });

const checksum = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const recoveryError = (failure: unknown, recovery: unknown): Error =>
  new Error(
    `${errorMessage(failure)}; stable bundle recovery requires attention: ${errorMessage(recovery)}`,
    { cause: failure },
  );

interface PreparedBundle {
  manifest: Buffer;
  signature: Buffer;
  installer: Buffer;
  promotion: StableBundlePromotion;
}

const prepareBundle = async (
  releaseDirectory: string,
  trustedPublicKeyPem: string,
  io: Pick<StableBundleIO, "readFile">,
): Promise<PreparedBundle> => {
  const [manifest, signature] = await Promise.all([
    readFile(join(releaseDirectory, "manifest.json")),
    readFile(join(releaseDirectory, "manifest.sig")),
  ]);
  verifyReleaseManifestWithIdentity(manifest, signature, trustedPublicKeyPem);
  const verified = await verifyReleaseDirectoryWithPublicKey(
    releaseDirectory,
    trustedPublicKeyPem,
  );
  if (checksum(manifest) !== verified.release.manifestSha256) {
    throw new TypeError("Release manifest changed while it was being verified.");
  }
  const candidateWrapper = await io.readFile(join(releaseDirectory, "argus"));
  if (checksum(candidateWrapper) !== verified.release.manifest.assets.wrapper.sha256) {
    throw new TypeError("Signed checksum mismatch for argus.");
  }
  const canonicalWrapper = Buffer.from(renderArgusWrapper());
  if (!candidateWrapper.equals(canonicalWrapper)) {
    throw new TypeError(
      "Candidate argus wrapper does not match the stable wrapper.",
    );
  }
  const installer = Buffer.from(
    renderInstaller({
      manifestUrl: stableManifestUrl,
      publicKeyPem: trustedPublicKeyPem,
    }),
  );
  return {
    manifest,
    signature,
    installer,
    promotion: {
      version: verified.release.manifest.version,
      manifestSha256: verified.release.manifestSha256,
      installerSha256: checksum(installer),
    },
  };
};

const discardDirectory = async (
  io: StableBundleIO,
  directory: string,
): Promise<void> => {
  if (await io.directoryExists(directory)) await io.removeDirectory(directory);
};

export const promoteStableBundle = async (
  releaseDirectory: string,
  stableDirectory: string,
  options: StableBundlePromotionOptions = {},
): Promise<StableBundlePromotion> => {
  const io = options.io ?? createStableBundleIO();
  const release = resolve(releaseDirectory);
  const stable = resolve(stableDirectory);
  const parent = dirname(stable);
  const stableName = basename(stable);
  if (stableName.length === 0 || stable === parent) {
    throw new TypeError("Stable bundle path must name a directory below its parent.");
  }
  const prepared = await prepareBundle(
    release,
    options.trustedPublicKeyPem ?? stableReleasePublicKey,
    io,
  );
  if (!(await io.directoryExists(parent))) {
    throw new TypeError(`Stable bundle parent directory does not exist: ${parent}`);
  }
  const staging = join(parent, `.${stableName}.staging-${randomUUID()}`);
  const backup = join(parent, `.${stableName}.backup-${randomUUID()}`);
  const failedCandidate = join(parent, `.${stableName}.failed-${randomUUID()}`);
  const hadStable = await io.directoryExists(stable);
  let stagingExists = false;
  let priorAtBackup = false;
  let candidateAtStable = false;
  let stableDurablyPublished = false;

  try {
    await io.mkdir(staging);
    stagingExists = true;
    await io.writeFileAndSync(join(staging, "install.sh"), prepared.installer, 0o755);
    await io.writeFileAndSync(join(staging, "manifest.json"), prepared.manifest, 0o644);
    await io.writeFileAndSync(join(staging, "manifest.sig"), prepared.signature, 0o644);
    await io.syncDirectory(staging);
    if (hadStable) {
      await io.rename(stable, backup);
      priorAtBackup = true;
    }
    await io.rename(staging, stable);
    stagingExists = false;
    candidateAtStable = true;
    await io.syncDirectory(parent);
    stableDurablyPublished = true;
    if (priorAtBackup) {
      await io.removeDirectory(backup);
      priorAtBackup = false;
      await io.syncDirectory(parent);
    }
    return prepared.promotion;
  } catch (failure) {
    if (stableDurablyPublished) {
      // The promoted bundle is already durably complete. A later backup cleanup
      // failure must not replace it with a partially removed predecessor.
      throw failure;
    }
    try {
      if (priorAtBackup) {
        if (candidateAtStable) {
          await io.rename(stable, failedCandidate);
          candidateAtStable = false;
        }
        await io.rename(backup, stable);
        priorAtBackup = false;
        try {
          await io.syncDirectory(parent);
        } catch (restoreFailure) {
          await io.rename(stable, backup);
          priorAtBackup = true;
          throw new Error(
            `Prior stable bundle is retained for recovery at ${backup}: ${errorMessage(restoreFailure)}`,
            { cause: restoreFailure },
          );
        }
        if (await io.directoryExists(failedCandidate)) {
          await io.removeDirectory(failedCandidate);
          await io.syncDirectory(parent);
        }
      } else if (candidateAtStable) {
        await io.rename(stable, failedCandidate);
        candidateAtStable = false;
        await io.syncDirectory(parent);
      }
      if (stagingExists) await discardDirectory(io, staging);
    } catch (recovery) {
      throw recoveryError(failure, recovery);
    }
    throw failure;
  }
};
