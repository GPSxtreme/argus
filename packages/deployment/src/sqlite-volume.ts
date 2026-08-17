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

const unavailable = (): DeploymentError =>
  new DeploymentError(
    "UPDATE_SQLITE_VOLUME_UNAVAILABLE",
    "Argus could not prove the managed SQLite Docker volume.",
    {
      recovery:
        "Run 'argus doctor --json' and verify the managed argus service mounts its Compose volume at /app/data.",
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
