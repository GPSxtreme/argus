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
): Promise<void> => {
  try {
    if ((await fileSystem.lstat(path)).isSymbolicLink()) {
      throw new TypeError(`Refusing symlink management state target: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

export const writeManagementStateAtomic = async (
  path: string,
  state: ManagementStateV1,
  fileSystem: ManagementStateFileSystem = filesystem,
): Promise<void> => {
  const contents = serializeManagementState(state);
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  let temporaryCreated = false;
  let temporaryFile: ManagementStateFileHandle | undefined;

  await assertNotSymlink(path, fileSystem);
  try {
    temporaryFile = await fileSystem.open(temporaryPath, "wx", 0o644);
    temporaryCreated = true;
    await temporaryFile.writeFile(contents);
    await temporaryFile.chmod(0o644);
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;

    await assertNotSymlink(path, fileSystem);
    await fileSystem.rename(temporaryPath, path);
    temporaryCreated = false;

    const directoryHandle = await fileSystem.open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    if (temporaryFile !== undefined) {
      await temporaryFile.close().catch(() => undefined);
    }
    if (temporaryCreated) {
      await fileSystem.unlink(temporaryPath).catch(() => undefined);
    }
    throw error;
  }
};
