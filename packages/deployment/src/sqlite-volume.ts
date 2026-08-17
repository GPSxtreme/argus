import { createHash } from "node:crypto";
import { chmod, lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { DeploymentError } from "./errors.js";
import type { CommandExecutor } from "./executor.js";

export interface SqliteVolumeIdentity {
  name: string;
  project: "argus";
  logicalName: "argus-data";
  destination: "/app/data";
}

export interface InspectSqliteVolumeInput {
  root: string;
  executor: CommandExecutor;
  environment: Record<string, string>;
}

export interface SqliteSnapshot {
  relativePath: string;
  sha256: string;
  bytes: number;
  quickCheck: "ok";
  counts: {
    records: number;
    revisions: number;
    jobs: number;
  };
  volume: SqliteVolumeIdentity;
}

export interface CreateSqliteSnapshotInput {
  root: string;
  backupRoot: string;
  executor: CommandExecutor;
  environment: Record<string, string>;
  image: string;
  volume: SqliteVolumeIdentity;
}

export interface VerifySqliteSnapshotInput {
  root: string;
  backupRoot: string;
  snapshot: SqliteSnapshot;
  executor: CommandExecutor;
  environment: Record<string, string>;
  image: string;
}

export interface RestoreSqliteSnapshotInput
  extends VerifySqliteSnapshotInput {
  volume: SqliteVolumeIdentity;
}

const containerIdSchema = z.string().regex(/^[a-f0-9]{12,64}$/u);
const mountListSchema = z.array(
  z
    .object({
      Destination: z.string(),
    })
    .passthrough(),
);
const dataMountSchema = z
  .object({
    Type: z.literal("volume"),
    Name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u),
    Destination: z.literal("/app/data"),
  })
  .passthrough();
const labelsSchema = z
  .object({
    "com.docker.compose.project": z.literal("argus"),
    "com.docker.compose.volume": z.literal("argus-data"),
  })
  .passthrough();
const digestPinnedImageSchema = z
  .string()
  .regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/u);
const snapshotReceiptSchema = z
  .object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    bytes: z.number().int().positive(),
    quickCheck: z.literal("ok"),
    counts: z
      .object({
        records: z.number().int().nonnegative(),
        revisions: z.number().int().nonnegative(),
        jobs: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

const snapshotHelper = String.raw`
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { chmod, chown, copyFile, mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [sourcePath, destinationPath, ownerUidText, ownerGidText] = process.argv.slice(1);
const ownerUid = Number(ownerUidText);
const ownerGid = Number(ownerGidText);
if (
  !sourcePath ||
  !destinationPath ||
  !Number.isSafeInteger(ownerUid) ||
  ownerUid < 0 ||
  !Number.isSafeInteger(ownerGid) ||
  ownerGid < 0
) throw new Error("snapshot paths and owner are required");

const quickCheck = (database) => {
  const rows = database.pragma("quick_check");
  if (rows.length !== 1 || rows[0]?.quick_check !== "ok") {
    throw new Error("SQLite quick_check failed");
  }
};

const stagedSourceRoot = await mkdtemp(join(tmpdir(), "argus-snapshot-"));
const stagedSourcePath = join(stagedSourceRoot, "argus.db");
try {
  await copyFile(sourcePath, stagedSourcePath);
  await copyFile(sourcePath + "-wal", stagedSourcePath + "-wal").catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  const source = new Database(stagedSourcePath, { fileMustExist: true });
  try {
    quickCheck(source);
    await source.backup(destinationPath);
  } finally {
    source.close();
  }
} finally {
  await rm(stagedSourceRoot, { recursive: true, force: true });
}

const snapshot = new Database(destinationPath, { readonly: true, fileMustExist: true });
quickCheck(snapshot);
const count = (table) => Number(snapshot.prepare('SELECT COUNT(*) AS count FROM "' + table + '"').get().count);
const counts = {
  records: count("records"),
  revisions: count("revisions"),
  jobs: count("jobs"),
};
snapshot.close();

const bytes = await readFile(destinationPath);
const metadata = await stat(destinationPath);
await chown(destinationPath, ownerUid, ownerGid);
await chmod(destinationPath, 0o600);
const file = await open(destinationPath, "r");
await file.sync();
await file.close();
const directory = await open("/backup", "r");
await directory.sync();
await directory.close();
process.stdout.write(JSON.stringify({
  sha256: createHash("sha256").update(bytes).digest("hex"),
  bytes: metadata.size,
  quickCheck: "ok",
  counts,
}) + "\\n");
`;

const verifyHelper = String.raw`
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

const [sourcePath] = process.argv.slice(1);
if (!sourcePath) throw new Error("snapshot path is required");
const database = new Database(sourcePath, { readonly: true, fileMustExist: true });
const quickCheck = database.pragma("quick_check", { simple: true });
if (quickCheck !== "ok") throw new Error("SQLite quick_check failed");
const count = (table) => Number(database.prepare('SELECT COUNT(*) AS count FROM "' + table + '"').get().count);
const counts = { records: count("records"), revisions: count("revisions"), jobs: count("jobs") };
database.close();
const bytes = await readFile(sourcePath);
const metadata = await stat(sourcePath);
process.stdout.write(JSON.stringify({
  sha256: createHash("sha256").update(bytes).digest("hex"),
  bytes: metadata.size,
  quickCheck,
  counts,
}) + "\\n");
`;

const restoreHelper = String.raw`
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, chown, copyFile, open, readFile, rename, rm, stat } from "node:fs/promises";

const [sourcePath, livePath, expectedJson] = process.argv.slice(1);
if (!sourcePath || !livePath || !expectedJson) throw new Error("restore arguments are required");
const expected = JSON.parse(expectedJson);
const inspect = async (path) => {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  const quickCheck = database.pragma("quick_check", { simple: true });
  if (quickCheck !== "ok") throw new Error("SQLite quick_check failed");
  const count = (table) => Number(database.prepare('SELECT COUNT(*) AS count FROM "' + table + '"').get().count);
  const counts = { records: count("records"), revisions: count("revisions"), jobs: count("jobs") };
  database.close();
  const bytes = await readFile(path);
  const metadata = await stat(path);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: metadata.size,
    quickCheck,
    counts,
  };
};
const matches = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sourceReceipt = await inspect(sourcePath);
if (!matches(sourceReceipt, expected)) throw new Error("snapshot receipt mismatch");

const stagedPath = "/data/.argus-restore-" + randomUUID() + ".db";
let promoted = false;
try {
  await copyFile(sourcePath, stagedPath, constants.COPYFILE_EXCL);
  const stagedReceipt = await inspect(stagedPath);
  if (!matches(stagedReceipt, expected)) throw new Error("staged snapshot mismatch");
  const liveMetadata = await stat(livePath).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  await chown(stagedPath, liveMetadata?.uid ?? 10001, liveMetadata?.gid ?? 10001);
  await chmod(stagedPath, liveMetadata === undefined ? 0o600 : liveMetadata.mode & 0o777);
  const staged = await open(stagedPath, "r");
  await staged.sync();
  await staged.close();

  if (liveMetadata !== undefined) {
    const live = new Database(livePath, { fileMustExist: true });
    try {
      const checkpoints = live.pragma("wal_checkpoint(TRUNCATE)");
      const checkpoint = checkpoints[0];
      if (
        checkpoints.length !== 1 ||
        checkpoint === undefined ||
        checkpoint.busy !== 0 ||
        checkpoint.log !== checkpoint.checkpointed
      ) {
        throw new Error("live SQLite WAL checkpoint remained busy");
      }
    } finally {
      live.close();
    }
  }
  await rm(livePath + "-wal", { force: true });
  await rm(livePath + "-shm", { force: true });
  await rename(stagedPath, livePath);
  promoted = true;
  const directory = await open("/data", "r");
  await directory.sync();
  await directory.close();
  process.stdout.write(JSON.stringify({ restored: true, ...stagedReceipt }) + "\\n");
} catch (error) {
  if (!promoted) await rm(stagedPath, { force: true });
  throw error;
}
`;

const unavailable = (): DeploymentError =>
  new DeploymentError(
    "UPDATE_SQLITE_VOLUME_UNAVAILABLE",
    "Argus could not prove the managed SQLite Docker volume.",
    {
      recovery:
        "Run 'argus doctor --json' and verify the managed argus service mounts its Compose volume at /app/data.",
    },
  );

const snapshotFailed = (): DeploymentError =>
  new DeploymentError(
    "UPDATE_SQLITE_SNAPSHOT_FAILED",
    "Argus could not create and verify the managed SQLite snapshot.",
    {
      recovery:
        "Keep the current Argus instance stopped, inspect Docker and disk health, then retry 'argus update'.",
    },
  );

const backupInvalid = (): DeploymentError =>
  new DeploymentError(
    "UPDATE_ROLLBACK_BACKUP_INVALID",
    "The persisted SQLite rollback snapshot is missing or invalid.",
    {
      recovery:
        "Preserve the instance backup and inspect its recorded hash before retrying rollback.",
    },
  );

const restoreFailed = (): DeploymentError =>
  new DeploymentError(
    "UPDATE_ROLLBACK_RESTORE_FAILED",
    "Argus could not atomically restore the verified SQLite snapshot.",
    {
      recovery:
        "Keep Argus stopped and preserve the recorded snapshot before attempting manual recovery.",
    },
  );

const run = async (
  executor: CommandExecutor,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs: number;
  },
): Promise<string> => {
  try {
    const result = await executor.run("docker", args, options);
    if (result.exitCode !== 0 || result.timedOut) throw unavailable();
    return result.stdout;
  } catch (error) {
    if (error instanceof DeploymentError) throw error;
    throw unavailable();
  }
};

const parseJson = (source: string): unknown => {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw unavailable();
  }
};

export const inspectSqliteVolume = async ({
  root,
  executor,
  environment,
}: InspectSqliteVolumeInput): Promise<SqliteVolumeIdentity> => {
  const serviceOutput = await run(
    executor,
    ["compose", "-p", "argus", "ps", "-q", "--all", "argus"],
    { cwd: root, env: environment, timeoutMs: 10_000 },
  );
  const containers = serviceOutput
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  if (containers.length !== 1) throw unavailable();
  const containerId = containerIdSchema.safeParse(containers[0]);
  if (!containerId.success) throw unavailable();

  const mountsOutput = await run(
    executor,
    ["inspect", "--format", "{{json .Mounts}}", containerId.data],
    { timeoutMs: 10_000 },
  );
  const mounts = mountListSchema.safeParse(parseJson(mountsOutput));
  if (!mounts.success) throw unavailable();
  const candidates = mounts.data.filter(
    (mount) => mount.Destination === "/app/data",
  );
  if (candidates.length !== 1) throw unavailable();
  const dataMount = dataMountSchema.safeParse(candidates[0]);
  if (!dataMount.success) throw unavailable();

  const labelsOutput = await run(
    executor,
    [
      "volume",
      "inspect",
      "--format",
      "{{json .Labels}}",
      dataMount.data.Name,
    ],
    { timeoutMs: 10_000 },
  );
  if (!labelsSchema.safeParse(parseJson(labelsOutput)).success) {
    throw unavailable();
  }

  return {
    name: dataMount.data.Name,
    project: "argus",
    logicalName: "argus-data",
    destination: "/app/data",
  };
};

export const createSqliteSnapshot = async ({
  root,
  backupRoot,
  executor,
  image,
  volume,
}: CreateSqliteSnapshotInput): Promise<SqliteSnapshot> => {
  try {
    const resolvedRoot = resolve(root);
    const resolvedBackupRoot = resolve(backupRoot);
    const relativeBackupRoot = relative(resolvedRoot, resolvedBackupRoot);
    if (
      relativeBackupRoot === "" ||
      relativeBackupRoot.startsWith("..") ||
      isAbsolute(relativeBackupRoot) ||
      !digestPinnedImageSchema.safeParse(image).success ||
      !dataMountSchema.safeParse({
        Type: "volume",
        Name: volume.name,
        Destination: volume.destination,
      }).success ||
      volume.project !== "argus" ||
      volume.logicalName !== "argus-data"
    ) {
      throw snapshotFailed();
    }
    const backupMetadata = await lstat(resolvedBackupRoot);
    if (!backupMetadata.isDirectory() || backupMetadata.isSymbolicLink()) {
      throw snapshotFailed();
    }
    const canonicalRoot = await realpath(resolvedRoot);
    const canonicalBackupRoot = await realpath(resolvedBackupRoot);
    const canonicalRelative = relative(canonicalRoot, canonicalBackupRoot);
    if (
      canonicalRelative === "" ||
      canonicalRelative.startsWith("..") ||
      isAbsolute(canonicalRelative)
    ) {
      throw snapshotFailed();
    }
    await chmod(resolvedBackupRoot, 0o700);

    const destination = join(resolvedBackupRoot, "argus.db");
    const commandResult = await executor.run(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        "0:0",
        "--mount",
        `type=volume,src=${volume.name},dst=/data,readonly`,
        "--mount",
        `type=bind,src=${resolvedBackupRoot},dst=/backup`,
        "--entrypoint",
        "node",
        image,
        "--input-type=module",
        "-e",
        snapshotHelper,
        "--",
        "/data/argus.db",
        "/backup/argus.db",
        String(process.getuid?.() ?? 0),
        String(process.getgid?.() ?? 0),
      ],
      { timeoutMs: 120_000 },
    );
    if (commandResult.exitCode !== 0 || commandResult.timedOut) {
      throw snapshotFailed();
    }
    const lines = commandResult.stdout.trim().split(/\r?\n/u);
    if (lines.length !== 1) throw snapshotFailed();
    const receipt = snapshotReceiptSchema.safeParse(parseJson(lines[0] ?? ""));
    if (!receipt.success) throw snapshotFailed();

    const metadata = await lstat(destination);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw snapshotFailed();
    await chmod(destination, 0o600);
    const securedMetadata = await lstat(destination);
    if (!securedMetadata.isFile() || securedMetadata.isSymbolicLink()) {
      throw snapshotFailed();
    }
    const bytes = await readFile(destination);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (
      securedMetadata.size !== receipt.data.bytes ||
      hash !== receipt.data.sha256
    ) {
      throw snapshotFailed();
    }

    return {
      relativePath: relative(resolvedRoot, destination),
      ...receipt.data,
      volume,
    };
  } catch (error) {
    if (process.env.ARGUS_SQLITE_VOLUME_TEST === "1") {
      const cause = error as NodeJS.ErrnoException;
      console.error(
        JSON.stringify({
          sqliteSnapshotInternalDiagnostic: true,
          name: cause.name,
          code: cause.code ?? null,
          syscall: cause.syscall ?? null,
          message: cause.message,
          stack: cause.stack?.split("\n").slice(0, 8) ?? [],
        }),
      );
    }
    if (
      error instanceof DeploymentError &&
      error.code === "UPDATE_SQLITE_SNAPSHOT_FAILED"
    ) {
      throw error;
    }
    throw snapshotFailed();
  }
};

const snapshotPath = async (
  root: string,
  backupRoot: string,
  snapshot: SqliteSnapshot,
): Promise<{ backupRoot: string; path: string }> => {
  const resolvedRoot = resolve(root);
  const resolvedBackupRoot = resolve(backupRoot);
  const path = resolve(resolvedRoot, snapshot.relativePath);
  const backupFromRoot = relative(resolvedRoot, resolvedBackupRoot);
  const pathFromBackup = relative(resolvedBackupRoot, path);
  if (
    backupFromRoot === "" ||
    backupFromRoot.startsWith("..") ||
    isAbsolute(backupFromRoot) ||
    pathFromBackup === "" ||
    pathFromBackup.startsWith("..") ||
    isAbsolute(pathFromBackup)
  ) {
    throw backupInvalid();
  }
  const backupMetadata = await lstat(resolvedBackupRoot);
  const metadata = await lstat(path);
  if (
    !backupMetadata.isDirectory() ||
    backupMetadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.isSymbolicLink()
  ) {
    throw backupInvalid();
  }
  const canonicalRoot = await realpath(resolvedRoot);
  const canonicalBackupRoot = await realpath(resolvedBackupRoot);
  const canonicalPath = await realpath(path);
  const canonicalBackupFromRoot = relative(canonicalRoot, canonicalBackupRoot);
  const canonicalPathFromBackup = relative(canonicalBackupRoot, canonicalPath);
  if (
    canonicalBackupFromRoot === "" ||
    canonicalBackupFromRoot.startsWith("..") ||
    isAbsolute(canonicalBackupFromRoot) ||
    canonicalPathFromBackup === "" ||
    canonicalPathFromBackup.startsWith("..") ||
    isAbsolute(canonicalPathFromBackup)
  ) {
    throw backupInvalid();
  }
  const bytes = await readFile(path);
  if (
    metadata.size !== snapshot.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== snapshot.sha256
  ) {
    throw backupInvalid();
  }
  return { backupRoot: resolvedBackupRoot, path };
};

const receiptMatches = (
  receipt: z.infer<typeof snapshotReceiptSchema>,
  snapshot: SqliteSnapshot,
): boolean =>
  receipt.sha256 === snapshot.sha256 &&
  receipt.bytes === snapshot.bytes &&
  receipt.quickCheck === snapshot.quickCheck &&
  receipt.counts.records === snapshot.counts.records &&
  receipt.counts.revisions === snapshot.counts.revisions &&
  receipt.counts.jobs === snapshot.counts.jobs;

const strictReceipt = (
  result: Awaited<ReturnType<CommandExecutor["run"]>>,
  failure: () => DeploymentError,
): z.infer<typeof snapshotReceiptSchema> => {
  if (result.exitCode !== 0 || result.timedOut) throw failure();
  const lines = result.stdout.trim().split(/\r?\n/u);
  if (lines.length !== 1) throw failure();
  const receipt = snapshotReceiptSchema.safeParse(parseJson(lines[0] ?? ""));
  if (!receipt.success) throw failure();
  return receipt.data;
};

export const verifySqliteSnapshot = async ({
  root,
  backupRoot,
  snapshot,
  executor,
  image,
}: VerifySqliteSnapshotInput): Promise<void> => {
  try {
    const confined = await snapshotPath(root, backupRoot, snapshot);
    if (!digestPinnedImageSchema.safeParse(image).success) throw backupInvalid();
    const result = await executor.run(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        "0:0",
        "--mount",
        `type=bind,src=${confined.backupRoot},dst=/backup,readonly`,
        "--entrypoint",
        "node",
        image,
        "--input-type=module",
        "-e",
        verifyHelper,
        "--",
        `/backup/${relative(confined.backupRoot, confined.path)}`,
      ],
      { timeoutMs: 120_000 },
    );
    if (!receiptMatches(strictReceipt(result, backupInvalid), snapshot)) {
      throw backupInvalid();
    }
  } catch (error) {
    if (error instanceof DeploymentError) throw error;
    throw backupInvalid();
  }
};

export const restoreSqliteSnapshot = async ({
  root,
  backupRoot,
  snapshot,
  executor,
  image,
  volume,
}: RestoreSqliteSnapshotInput): Promise<void> => {
  try {
    const confined = await snapshotPath(root, backupRoot, snapshot);
    if (
      !digestPinnedImageSchema.safeParse(image).success ||
      JSON.stringify(volume) !== JSON.stringify(snapshot.volume)
    ) {
      throw restoreFailed();
    }
    const expected = {
      sha256: snapshot.sha256,
      bytes: snapshot.bytes,
      quickCheck: snapshot.quickCheck,
      counts: snapshot.counts,
    };
    const result = await executor.run(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        "0:0",
        "--mount",
        `type=volume,src=${volume.name},dst=/data`,
        "--mount",
        `type=bind,src=${confined.backupRoot},dst=/backup,readonly`,
        "--entrypoint",
        "node",
        image,
        "--input-type=module",
        "-e",
        restoreHelper,
        "--",
        `/backup/${relative(confined.backupRoot, confined.path)}`,
        "/data/argus.db",
        JSON.stringify(expected),
      ],
      { timeoutMs: 120_000 },
    );
    if (result.exitCode !== 0 || result.timedOut) throw restoreFailed();
    const lines = result.stdout.trim().split(/\r?\n/u);
    if (lines.length !== 1) throw restoreFailed();
    const restored = z
      .object({ restored: z.literal(true), ...snapshotReceiptSchema.shape })
      .strict()
      .safeParse(parseJson(lines[0] ?? ""));
    if (!restored.success || !receiptMatches(restored.data, snapshot)) {
      throw restoreFailed();
    }
  } catch (error) {
    if (error instanceof DeploymentError) throw error;
    throw restoreFailed();
  }
};
