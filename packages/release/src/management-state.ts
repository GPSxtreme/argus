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
  close(): Promise<void>;
}

export interface ManagementStateFileSystem {
  lstat(path: string): Promise<{ isSymbolicLink(): boolean }>;
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

const assertNotSymlink = async (
  path: string,
  fileSystem: ManagementStateFileSystem,
): Promise<boolean> => {
  try {
    if ((await fileSystem.lstat(path)).isSymbolicLink()) {
      throw new TypeError(`Refusing symlink management state target: ${path}`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
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

export const writeManagementStateAtomic = async (
  path: string,
  state: ManagementStateV1,
  fileSystem: ManagementStateFileSystem = filesystem,
): Promise<void> => {
  const contents = serializeManagementState(state);
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  const backupPath = join(directory, `.${basename(path)}.backup-${randomUUID()}`);
  const failedCandidatePath = join(directory, `.${basename(path)}.failed-${randomUUID()}`);
  let temporaryCreated = false;
  let temporaryFile: ManagementStateFileHandle | undefined;
  let priorAtBackup = false;
  let candidateAtPath = false;
  let failedCandidateExists = false;
  let stateDurablyPromoted = false;

  await assertNotSymlink(path, fileSystem);
  try {
    temporaryFile = await fileSystem.open(temporaryPath, "wx", 0o644);
    temporaryCreated = true;
    await temporaryFile.writeFile(contents);
    await temporaryFile.chmod(0o644);
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;

    const hadPreviousState = await assertNotSymlink(path, fileSystem);
    if (hadPreviousState) {
      await fileSystem.rename(path, backupPath);
      priorAtBackup = true;
      await syncDirectory(directory, fileSystem);
    }

    await assertNotSymlink(temporaryPath, fileSystem);
    await assertNotSymlink(path, fileSystem);
    await fileSystem.rename(temporaryPath, path);
    temporaryCreated = false;
    candidateAtPath = true;

    await syncDirectory(directory, fileSystem);
    stateDurablyPromoted = true;

    if (priorAtBackup) {
      await fileSystem.unlink(backupPath);
      priorAtBackup = false;
      await syncDirectory(directory, fileSystem);
    }
  } catch (failure) {
    if (stateDurablyPromoted) {
      const cleanup = priorAtBackup
        ? `prior state remains at ${backupPath}`
        : `directory cleanup durability could not be confirmed in ${directory}`;
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
      if (priorAtBackup) {
        if (candidateAtPath) {
          try {
            await fileSystem.rename(path, failedCandidatePath);
          } catch (candidateRecoveryFailure) {
            throw retainedPriorStateError(
              backupPath,
              path,
              directory,
              candidateRecoveryFailure,
            );
          }
          candidateAtPath = false;
          failedCandidateExists = true;
        }
        await assertNotSymlink(backupPath, fileSystem);
        try {
          await fileSystem.rename(backupPath, path);
        } catch (restoreRenameFailure) {
          throw retainedPriorStateError(backupPath, path, directory, restoreRenameFailure);
        }
        priorAtBackup = false;
        try {
          await syncDirectory(directory, fileSystem);
        } catch (restoreFailure) {
          await fileSystem.rename(path, backupPath);
          priorAtBackup = true;
          throw retainedPriorStateError(backupPath, path, directory, restoreFailure);
        }
        if (failedCandidateExists) {
          await fileSystem.unlink(failedCandidatePath);
          failedCandidateExists = false;
          await syncDirectory(directory, fileSystem);
        }
      } else if (candidateAtPath) {
        try {
          await fileSystem.rename(path, failedCandidatePath);
        } catch (candidateRecoveryFailure) {
          throw new Error(
            `Promoted management state remains at ${path}; remove it and sync ${directory} to restore the prior absence: ${errorMessage(candidateRecoveryFailure)}`,
            { cause: candidateRecoveryFailure },
          );
        }
        candidateAtPath = false;
        failedCandidateExists = true;
        await syncDirectory(directory, fileSystem);
        await fileSystem.unlink(failedCandidatePath);
        failedCandidateExists = false;
        await syncDirectory(directory, fileSystem);
      }
      if (temporaryCreated) {
        await fileSystem.unlink(temporaryPath);
        temporaryCreated = false;
        await syncDirectory(directory, fileSystem);
      }
      if (closeFailure !== undefined) throw closeFailure;
    } catch (recovery) {
      throw recoveryError(failure, recovery);
    }
    throw failure;
  }
};
