import { randomUUID } from "node:crypto";
import {
  lstat,
  open,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  isNormalizedSemVer,
  isPinnedImageReference,
  MANAGEMENT_WRAPPER_REQUIREMENTS,
} from "@argus/contracts";
import type { VerifiedReleaseManifest } from "./manifest.js";

export interface ManagementStateV1 {
  schema: 1;
  version: string;
  cliImage: `${string}@sha256:${string}`;
}

interface ManagementStateFileHandle {
  writeFile(contents: string): Promise<void>;
  chmod(mode: number): Promise<void>;
  sync(): Promise<void>;
  stat(): Promise<{ dev: number; ino: number }>;
  close(): Promise<void>;
}

export interface ManagementStateFileSystem {
  lstat(path: string): Promise<{
    dev: number;
    ino: number;
    isSymbolicLink(): boolean;
  }>;
  open(path: string, flags: string, mode?: number): Promise<ManagementStateFileHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const filesystem: ManagementStateFileSystem = {
  lstat,
  open: (path, flags, mode) => open(path, flags, mode) as Promise<FileHandle>,
  rename,
  unlink,
};

const invalidState = (detail: string): never => {
  throw new TypeError(`Invalid management state: ${detail}`);
};

const assertValidState = (state: ManagementStateV1): void => {
  if (state.schema !== MANAGEMENT_WRAPPER_REQUIREMENTS.stateSchema) {
    invalidState("unsupported schema.");
  }
  if (!isNormalizedSemVer(state.version)) {
    invalidState("version must be normalized SemVer.");
  }
  if (!isPinnedImageReference(state.cliImage)) {
    invalidState("CLI image must be credential-free and digest-pinned.");
  }
};

export const managementStateForRelease = (
  release: VerifiedReleaseManifest,
): ManagementStateV1 => ({
  schema: MANAGEMENT_WRAPPER_REQUIREMENTS.stateSchema,
  version: release.manifest.version,
  cliImage: release.manifest.images.cli.reference as ManagementStateV1["cliImage"],
});

export const serializeManagementState = (state: ManagementStateV1): string => {
  assertValidState(state);
  const source = `schema=${state.schema}\nversion=${state.version}\ncli_image=${state.cliImage}\n`;
  if (Buffer.byteLength(source, "utf8") > MANAGEMENT_WRAPPER_REQUIREMENTS.maximumStateBytes) {
    invalidState("exceeds the maximum size.");
  }
  return source;
};

export const parseManagementState = (source: string): ManagementStateV1 => {
  if (Buffer.byteLength(source, "utf8") > MANAGEMENT_WRAPPER_REQUIREMENTS.maximumStateBytes) {
    invalidState("exceeds the maximum size.");
  }
  if (source.includes("\0")) invalidState("contains a NUL byte.");

  const lines = source.split("\n");
  const versionLine = lines[1];
  const cliImageLine = lines[2];
  if (versionLine === undefined || cliImageLine === undefined) {
    throw new TypeError("Invalid management state: must contain exactly three ordered lines.");
  }
  if (
    lines.length !== 4 ||
    lines[3] !== "" ||
    lines[0] !== `schema=${MANAGEMENT_WRAPPER_REQUIREMENTS.stateSchema}` ||
    !versionLine.startsWith("version=") ||
    !cliImageLine.startsWith("cli_image=")
  ) {
    invalidState("must contain exactly three ordered lines.");
  }

  const state: ManagementStateV1 = {
    schema: MANAGEMENT_WRAPPER_REQUIREMENTS.stateSchema,
    version: versionLine.slice("version=".length),
    cliImage: cliImageLine.slice("cli_image=".length) as ManagementStateV1["cliImage"],
  };
  assertValidState(state);
  if (serializeManagementState(state) !== source) {
    invalidState("is not canonically encoded.");
  }
  return state;
};

interface FileIdentity {
  dev: number;
  ino: number;
}

interface PathEntry {
  identity: FileIdentity;
  isSymbolicLink: boolean;
}

interface HeldManagementStateLock {
  handle: ManagementStateFileHandle;
  identity: FileIdentity;
  path: string;
}

const isMissing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

const isExisting = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "EEXIST";

const identityOf = (metadata: { dev: number; ino: number }): FileIdentity => ({
  dev: metadata.dev,
  ino: metadata.ino,
});

const sameIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const inspectEntry = async (
  path: string,
  fileSystem: ManagementStateFileSystem,
): Promise<PathEntry | undefined> => {
  try {
    const metadata = await fileSystem.lstat(path);
    return {
      identity: identityOf(metadata),
      isSymbolicLink: metadata.isSymbolicLink(),
    };
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
};

const inspectPath = async (
  path: string,
  fileSystem: ManagementStateFileSystem,
): Promise<FileIdentity | undefined> => {
  const entry = await inspectEntry(path, fileSystem);
  if (entry?.isSymbolicLink) {
    throw new TypeError(`Management state ownership check failed: refusing symlink ${path}`);
  }
  return entry?.identity;
};

const requireIdentity = async (
  path: string,
  expected: FileIdentity,
  fileSystem: ManagementStateFileSystem,
): Promise<void> => {
  const observed = await inspectPath(path, fileSystem);
  if (observed === undefined || !sameIdentity(observed, expected)) {
    throw new Error(`Management state ownership check failed for ${path}.`);
  }
};

const requireAbsent = async (
  path: string,
  fileSystem: ManagementStateFileSystem,
): Promise<void> => {
  if ((await inspectPath(path, fileSystem)) !== undefined) {
    throw new Error(`Management state ownership check failed: ${path} appeared unexpectedly.`);
  }
};

const quarantineSelectedEntry = async (
  path: string,
  quarantinePath: string,
  expected: FileIdentity,
  fileSystem: ManagementStateFileSystem,
): Promise<{ exists: boolean; owned: boolean }> => {
  const observed = await inspectEntry(path, fileSystem);
  if (observed === undefined) return { exists: false, owned: false };
  const owned = !observed.isSymbolicLink && sameIdentity(observed.identity, expected);
  await fileSystem.rename(path, quarantinePath);
  const quarantined = await inspectEntry(quarantinePath, fileSystem);
  if (
    quarantined === undefined ||
    quarantined.isSymbolicLink !== observed.isSymbolicLink ||
    !sameIdentity(quarantined.identity, observed.identity)
  ) {
    throw new Error(
      `Management state ownership check failed while quarantining ${path} at ${quarantinePath}.`,
    );
  }
  return { exists: true, owned };
};

const syncDirectory = async (
  directory: string,
  fileSystem: ManagementStateFileSystem,
): Promise<void> => {
  const directoryHandle = await fileSystem.open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const recoveryError = (failure: unknown, recovery: unknown): Error =>
  new Error(
    `${errorMessage(failure)}; management state recovery requires attention: ${errorMessage(recovery)}`,
    { cause: failure },
  );

const retainedPriorStateError = (
  backupPath: string,
  path: string,
  directory: string,
  failure: unknown,
): Error =>
  new Error(
    `Prior management state is retained for recovery at ${backupPath}; restore it to ${path} and sync ${directory}: ${errorMessage(failure)}`,
    { cause: failure },
  );

const releaseManagementStateLock = async (
  lock: HeldManagementStateLock,
  directory: string,
  fileSystem: ManagementStateFileSystem,
): Promise<void> => {
  let releaseFailure: unknown;
  try {
    await requireIdentity(lock.path, lock.identity, fileSystem);
    await fileSystem.unlink(lock.path);
    await syncDirectory(directory, fileSystem);
  } catch (error) {
    releaseFailure = new Error(
      `Management state lock cleanup could not be confirmed at ${lock.path}; inspect it before retrying: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  try {
    await lock.handle.close();
  } catch (error) {
    releaseFailure =
      releaseFailure === undefined ? error : recoveryError(releaseFailure, error);
  }
  if (releaseFailure !== undefined) throw releaseFailure;
};

const acquireManagementStateLock = async (
  path: string,
  directory: string,
  fileSystem: ManagementStateFileSystem,
): Promise<HeldManagementStateLock> => {
  let handle: ManagementStateFileHandle;
  try {
    handle = await fileSystem.open(path, "wx", 0o600);
  } catch (error) {
    if (isExisting(error)) {
      throw new Error(
        `Management state is locked at ${path}; another writer may be active. If no writer is active, remove the stale lock and sync ${directory} before retrying.`,
        { cause: error },
      );
    }
    throw error;
  }

  let identity: FileIdentity;
  try {
    identity = identityOf(await handle.stat());
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw new Error(
      `Management state lock ownership could not be established at ${path}; the lock was retained for inspection: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  const lock = { handle, identity, path };
  try {
    await handle.chmod(0o600);
    await handle.sync();
    await requireIdentity(path, identity, fileSystem);
    await syncDirectory(directory, fileSystem);
    await requireIdentity(path, identity, fileSystem);
    return lock;
  } catch (failure) {
    try {
      await releaseManagementStateLock(lock, directory, fileSystem);
    } catch (cleanupFailure) {
      throw recoveryError(failure, cleanupFailure);
    }
    throw failure;
  }
};

const backupCleanupDescription = async (
  backupPath: string,
  priorIdentity: FileIdentity | undefined,
  directory: string,
  fileSystem: ManagementStateFileSystem,
): Promise<string> => {
  if (priorIdentity !== undefined) {
    try {
      const observed = await inspectPath(backupPath, fileSystem);
      if (observed !== undefined && sameIdentity(observed, priorIdentity)) {
        return `prior state remains at ${backupPath}`;
      }
    } catch {
      // The diagnostic below deliberately reports uncertainty.
    }
  }
  return `prior-state cleanup could not be confirmed in ${directory}`;
};

const writeManagementStateWhileLocked = async (
  path: string,
  contents: string,
  fileSystem: ManagementStateFileSystem,
): Promise<void> => {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  const backupPath = join(directory, `.${basename(path)}.backup-${randomUUID()}`);
  const failedCandidatePath = join(directory, `.${basename(path)}.failed-${randomUUID()}`);
  let temporaryCreated = false;
  let temporaryFile: ManagementStateFileHandle | undefined;
  let priorIdentity: FileIdentity | undefined;
  let candidateIdentity: FileIdentity | undefined;
  let priorAtBackup = false;
  let candidateAtPath = false;
  let failedCandidateExists = false;
  let failedCandidateOwned = false;
  let stateDurablyPromoted = false;

  await inspectPath(path, fileSystem);
  try {
    temporaryFile = await fileSystem.open(temporaryPath, "wx", 0o644);
    temporaryCreated = true;
    await temporaryFile.writeFile(contents);
    await temporaryFile.chmod(0o644);
    await temporaryFile.sync();
    candidateIdentity = identityOf(await temporaryFile.stat());
    await temporaryFile.close();
    temporaryFile = undefined;

    priorIdentity = await inspectPath(path, fileSystem);
    if (priorIdentity !== undefined) {
      await fileSystem.rename(path, backupPath);
      priorAtBackup = true;
      await requireIdentity(backupPath, priorIdentity, fileSystem);
      await syncDirectory(directory, fileSystem);
      await requireIdentity(backupPath, priorIdentity, fileSystem);
      await requireAbsent(path, fileSystem);
    }

    await requireIdentity(temporaryPath, candidateIdentity, fileSystem);
    await requireAbsent(path, fileSystem);
    await fileSystem.rename(temporaryPath, path);
    temporaryCreated = false;
    candidateAtPath = true;
    await requireIdentity(path, candidateIdentity, fileSystem);

    await syncDirectory(directory, fileSystem);
    await requireIdentity(path, candidateIdentity, fileSystem);
    stateDurablyPromoted = true;

    if (priorAtBackup && priorIdentity !== undefined) {
      await requireIdentity(path, candidateIdentity, fileSystem);
      await requireIdentity(backupPath, priorIdentity, fileSystem);
      await fileSystem.unlink(backupPath);
      priorAtBackup = false;
      await syncDirectory(directory, fileSystem);
      await requireIdentity(path, candidateIdentity, fileSystem);
      await requireAbsent(backupPath, fileSystem);
    }
  } catch (failure) {
    if (stateDurablyPromoted) {
      const cleanup = await backupCleanupDescription(
        backupPath,
        priorIdentity,
        directory,
        fileSystem,
      );
      throw new Error(
        `Management state was durably promoted at ${path}, but ${cleanup}; inspect the directory before retrying: ${errorMessage(failure)}`,
        { cause: failure },
      );
    }

    let closeFailure: unknown;
    if (temporaryFile !== undefined) {
      try {
        await temporaryFile.close();
      } catch (error) {
        closeFailure = error;
      }
      temporaryFile = undefined;
    }
    try {
      let unexpectedEntryRetained = false;
      if (priorAtBackup && priorIdentity !== undefined) {
        if (candidateAtPath) {
          try {
            if (candidateIdentity === undefined) {
              throw new Error("candidate identity is unavailable");
            }
            const quarantined = await quarantineSelectedEntry(
              path,
              failedCandidatePath,
              candidateIdentity,
              fileSystem,
            );
            failedCandidateExists = quarantined.exists;
            failedCandidateOwned = quarantined.owned;
            unexpectedEntryRetained = quarantined.exists && !quarantined.owned;
          } catch (candidateRecoveryFailure) {
            throw retainedPriorStateError(
              backupPath,
              path,
              directory,
              candidateRecoveryFailure,
            );
          }
          candidateAtPath = false;
        }
        await requireIdentity(backupPath, priorIdentity, fileSystem);
        try {
          await fileSystem.rename(backupPath, path);
        } catch (restoreRenameFailure) {
          throw retainedPriorStateError(backupPath, path, directory, restoreRenameFailure);
        }
        priorAtBackup = false;
        try {
          await requireIdentity(path, priorIdentity, fileSystem);
        } catch (ownershipFailure) {
          try {
            await fileSystem.rename(path, backupPath);
            await syncDirectory(directory, fileSystem);
            await requireAbsent(path, fileSystem);
          } catch (quarantineFailure) {
            throw recoveryError(ownershipFailure, quarantineFailure);
          }
          throw new Error(
            `Management state ownership check failed after restore; the unexpected entry was moved out of ${path} to ${backupPath}.`,
            { cause: ownershipFailure },
          );
        }
        try {
          await syncDirectory(directory, fileSystem);
          await requireIdentity(path, priorIdentity, fileSystem);
        } catch (restoreFailure) {
          await requireIdentity(path, priorIdentity, fileSystem);
          await fileSystem.rename(path, backupPath);
          await requireIdentity(backupPath, priorIdentity, fileSystem);
          priorAtBackup = true;
          throw retainedPriorStateError(backupPath, path, directory, restoreFailure);
        }
        if (failedCandidateExists && failedCandidateOwned && candidateIdentity !== undefined) {
          await requireIdentity(failedCandidatePath, candidateIdentity, fileSystem);
          await fileSystem.unlink(failedCandidatePath);
          failedCandidateExists = false;
          await syncDirectory(directory, fileSystem);
          await requireIdentity(path, priorIdentity, fileSystem);
          await requireAbsent(failedCandidatePath, fileSystem);
        }
      } else if (candidateAtPath && candidateIdentity !== undefined) {
        try {
          const quarantined = await quarantineSelectedEntry(
            path,
            failedCandidatePath,
            candidateIdentity,
            fileSystem,
          );
          failedCandidateExists = quarantined.exists;
          failedCandidateOwned = quarantined.owned;
          unexpectedEntryRetained = quarantined.exists && !quarantined.owned;
        } catch (candidateRecoveryFailure) {
          throw new Error(
            `Promoted management state at ${path} is not owned by this writer; inspect it and sync ${directory} before retrying: ${errorMessage(candidateRecoveryFailure)}`,
            { cause: candidateRecoveryFailure },
          );
        }
        candidateAtPath = false;
        await syncDirectory(directory, fileSystem);
        await requireAbsent(path, fileSystem);
        if (failedCandidateExists && failedCandidateOwned) {
          await requireIdentity(failedCandidatePath, candidateIdentity, fileSystem);
          await fileSystem.unlink(failedCandidatePath);
          failedCandidateExists = false;
          await syncDirectory(directory, fileSystem);
          await requireAbsent(path, fileSystem);
          await requireAbsent(failedCandidatePath, fileSystem);
        }
      }
      if (temporaryCreated) {
        const temporaryIdentity = await inspectPath(temporaryPath, fileSystem);
        if (candidateIdentity !== undefined) {
          if (temporaryIdentity === undefined || !sameIdentity(temporaryIdentity, candidateIdentity)) {
            throw new Error(
              `Management state ownership check failed for temporary state ${temporaryPath}.`,
            );
          }
        } else {
          if (temporaryIdentity !== undefined) {
            throw new Error(
              `Temporary management state ownership is unknown; the entry was retained for inspection at ${temporaryPath}.`,
            );
          }
          throw new Error(`Temporary management state disappeared from ${temporaryPath}.`);
        }
        await fileSystem.unlink(temporaryPath);
        temporaryCreated = false;
        await syncDirectory(directory, fileSystem);
      }
      if (unexpectedEntryRetained) {
        throw new Error(
          `Unexpected live management state was retained for inspection at ${failedCandidatePath}.`,
        );
      }
      if (closeFailure !== undefined) throw closeFailure;
    } catch (recovery) {
      throw recoveryError(failure, recovery);
    }
    throw failure;
  }
};

export const writeManagementStateAtomic = async (
  path: string,
  state: ManagementStateV1,
  fileSystem: ManagementStateFileSystem = filesystem,
): Promise<void> => {
  const contents = serializeManagementState(state);
  const directory = dirname(path);
  const lockPath = join(directory, `.${basename(path)}.lock`);
  const lock = await acquireManagementStateLock(lockPath, directory, fileSystem);
  let writeFailure: unknown;
  try {
    await writeManagementStateWhileLocked(path, contents, fileSystem);
  } catch (error) {
    writeFailure = error;
  }
  try {
    await releaseManagementStateLock(lock, directory, fileSystem);
  } catch (lockFailure) {
    if (writeFailure !== undefined) throw recoveryError(writeFailure, lockFailure);
    throw new Error(
      `Management state transaction completed, but lock cleanup requires attention: ${errorMessage(lockFailure)}`,
      { cause: lockFailure },
    );
  }
  if (writeFailure !== undefined) throw writeFailure;
};
