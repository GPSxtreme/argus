import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
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
import { open, readFile, stat } from "node:fs/promises";

const [sourcePath, destinationPath] = process.argv.slice(1);
if (!sourcePath || !destinationPath) throw new Error("snapshot paths are required");

const quickCheck = (database) => {
  const rows = database.pragma("quick_check");
  if (rows.length !== 1 || rows[0]?.quick_check !== "ok") {
    throw new Error("SQLite quick_check failed");
  }
};

const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
quickCheck(source);
await source.backup(destinationPath);
source.close();

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
    ["compose", "-p", "argus", "ps", "-q", "argus"],
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
        `type=volume,src=${volume.name},dst=/data`,
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
    const bytes = await readFile(destination);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (metadata.size !== receipt.data.bytes || hash !== receipt.data.sha256) {
      throw snapshotFailed();
    }

    return {
      relativePath: relative(resolvedRoot, destination),
      ...receipt.data,
      volume,
    };
  } catch (error) {
    if (
      error instanceof DeploymentError &&
      error.code === "UPDATE_SQLITE_SNAPSHOT_FAILED"
    ) {
      throw error;
    }
    throw snapshotFailed();
  }
};
