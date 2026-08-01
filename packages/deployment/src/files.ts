import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadConfig } from "@argus/config";
import { deploymentStateSchema, type DeploymentStateV1 } from "./contracts.js";
import type { RenderedInstanceConfig } from "./config.js";

export interface InstancePaths {
  config: string;
  secrets: string;
  state: string;
}

export const instancePaths = (root: string): InstancePaths => ({
  config: join(root, "argus.yaml"),
  secrets: join(root, "secrets.env"),
  state: join(root, "state.json"),
});

export interface InstanceIO {
  mkdir: typeof mkdir;
  open: typeof open;
  readFile: typeof readFile;
  rename: typeof rename;
  unlink: typeof unlink;
}

export const nodeInstanceIO: InstanceIO = { mkdir, open, readFile, rename, unlink };

const atomicWrite = async (
  path: string,
  contents: string,
  mode: number,
  io: InstanceIO,
): Promise<void> => {
  await io.mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await io.open(temporaryPath, "w", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await io.rename(temporaryPath, path);
};

export interface WriteInstanceFilesInput {
  root: string;
  rendered: RenderedInstanceConfig;
  io?: InstanceIO;
}

export const writeInstanceFiles = async ({
  root,
  rendered,
  io = nodeInstanceIO,
}: WriteInstanceFilesInput): Promise<void> => {
  const paths = instancePaths(root);
  const temporaryConfig = `${paths.config}.${process.pid}.${crypto.randomUUID()}.validate`;
  await io.mkdir(dirname(paths.config), { recursive: true });
  const validationHandle = await io.open(temporaryConfig, "w", 0o600);
  try {
    await validationHandle.writeFile(rendered.yaml, "utf8");
    await validationHandle.sync();
  } finally {
    await validationHandle.close();
  }
  try {
    await loadConfig(temporaryConfig, rendered.secretEnvironment);
  } finally {
    await io.unlink(temporaryConfig).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
  await atomicWrite(paths.config, rendered.yaml, 0o644, io);
  await atomicWrite(paths.secrets, rendered.secrets, 0o600, io);
};

export const loadDeploymentState = async (root: string): Promise<DeploymentStateV1 | undefined> => {
  try {
    const parsed = deploymentStateSchema.parse(
      JSON.parse(await readFile(instancePaths(root).state, "utf8")),
    );
    const { fxembed, ...state } = parsed;
    return fxembed === undefined ? state : { ...state, fxembed };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

export const saveDeploymentState = async (
  root: string,
  state: DeploymentStateV1,
): Promise<void> => {
  const parsed = deploymentStateSchema.parse(state);
  await atomicWrite(instancePaths(root).state, `${JSON.stringify(parsed, null, 2)}\n`, 0o644, nodeInstanceIO);
};
