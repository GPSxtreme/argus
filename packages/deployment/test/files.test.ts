import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  instancePaths,
  loadDeploymentState,
  nodeInstanceIO,
  renderInstanceConfig,
  saveDeploymentState,
  writeInstanceFiles,
} from "../src/index.js";
import type { DeploymentStateV1, OnboardingAnswersV1 } from "../src/contracts.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const answers: OnboardingAnswersV1 = {
  version: 1,
  deployment: {
    provider: "vps-docker",
    root: "/opt/argus",
    storage: "sqlite",
    apiHost: "0.0.0.0",
    apiPort: 8788,
  },
  managed: { searxng: "managed", fxembed: "managed" },
  cloudflare: { accountId: "test-account" },
  watches: [],
  intelligence: { enabled: false, model: "openai/gpt-4.1-mini" },
};

const rendered = renderInstanceConfig(answers, {
  searxng: "http://searxng:8080",
  fxembed: "https://argus-fx.workers.dev/api",
  apiToken: "api-secret",
});

describe("instance files", () => {
  it("creates secrets.env with mode 0600", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-instance-"));
    roots.push(root);

    await writeInstanceFiles({ root, rendered, io: nodeInstanceIO });

    const mode = (await stat(join(root, "secrets.env"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("writes only the managed SearXNG secret to its dedicated 0600 file", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-instance-"));
    roots.push(root);

    await writeInstanceFiles({ root, rendered, io: nodeInstanceIO });

    const path = join(root, "searxng", "secrets.env");
    expect(await readFile(path, "utf8")).toBe(
      "SEARXNG_SECRET=1f00076a613e2faf84e8bc33a6230860bf43be86af998e5f93a1dfd455c9a4c8\n",
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(join(root, "secrets.env"), "utf8")).not.toContain(
      "SEARXNG_SECRET",
    );
  });

  it("removes a stale managed SearXNG secret when managed mode is disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-instance-"));
    roots.push(root);
    const path = join(root, "searxng", "secrets.env");
    await mkdir(join(root, "searxng"));
    await writeFile(path, "SEARXNG_SECRET=stale\n", { mode: 0o600 });
    const { searxngSecrets: _searxngSecrets, ...withoutSearxngSecrets } =
      rendered;

    await writeInstanceFiles({
      root,
      rendered: withoutSearxngSecrets,
      io: nodeInstanceIO,
    });

    await expect(readFile(path, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("writes YAML without a secret value and with mode 0644", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-instance-"));
    roots.push(root);

    await writeInstanceFiles({ root, rendered, io: nodeInstanceIO });

    const yaml = await readFile(join(root, "argus.yaml"), "utf8");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Secret references intentionally use literal environment-placeholder syntax.
    expect(yaml).toContain("token: ${ARGUS_API_TOKEN}");
    expect(yaml).not.toContain("api-secret");
    const mode = (await stat(join(root, "argus.yaml"))).mode & 0o777;
    expect(mode).toBe(0o644);
  });

  it("replaces existing files with their required modes", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-instance-"));
    roots.push(root);
    await writeFile(join(root, "argus.yaml"), "old config", { mode: 0o600 });
    await writeFile(join(root, "secrets.env"), "old secrets", { mode: 0o644 });
    await chmod(join(root, "argus.yaml"), 0o600);
    await chmod(join(root, "secrets.env"), 0o644);

    await writeInstanceFiles({ root, rendered, io: nodeInstanceIO });

    expect((await stat(join(root, "argus.yaml"))).mode & 0o777).toBe(0o644);
    expect((await stat(join(root, "secrets.env"))).mode & 0o777).toBe(0o600);
  });

  it("removes a failed write temporary sibling while preserving the error", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-instance-"));
    roots.push(root);
    const renameError = new Error("rename failed");
    const io = { ...nodeInstanceIO, rename: vi.fn(async () => Promise.reject(renameError)) };

    await expect(writeInstanceFiles({ root, rendered, io })).rejects.toBe(renameError);

    expect(await readdir(root)).toEqual([]);
  });

  it("removes invalid validation input and preserves live files", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-instance-"));
    roots.push(root);
    await writeFile(join(root, "argus.yaml"), "existing config");
    await writeFile(join(root, "secrets.env"), "existing secrets");

    await expect(
      writeInstanceFiles({
        root,
        rendered: { ...rendered, yaml: "version: invalid\n" },
        io: nodeInstanceIO,
      }),
    ).rejects.toThrow();

    expect(await readFile(join(root, "argus.yaml"), "utf8")).toBe("existing config");
    expect(await readFile(join(root, "secrets.env"), "utf8")).toBe("existing secrets");
    expect(await readdir(root)).toEqual(["argus.yaml", "secrets.env"]);
  });

  it("fsyncs the containing directory after each renamed file", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-instance-"));
    roots.push(root);
    const originalOpen = nodeInstanceIO.open;
    let directorySyncs = 0;
    let directoryCloses = 0;
    const open = vi.spyOn(nodeInstanceIO, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (
        (args[0] === root || args[0] === join(root, "searxng")) &&
        args[1] === "r"
      ) {
        const sync = handle.sync.bind(handle);
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          directorySyncs += 1;
          await sync();
        });
        vi.spyOn(handle, "close").mockImplementation(async () => {
          directoryCloses += 1;
          await close();
        });
      }
      return handle;
    });

    await writeInstanceFiles({ root, rendered, io: nodeInstanceIO });
    await saveDeploymentState(root, {
      schemaVersion: 1,
      argusVersion: "0.1.0",
      composeProject: "argus",
      configHash: "abc123",
      services: {},
      updatedAt: "2026-08-01T00:00:00.000Z",
    });

    expect(
      open.mock.calls.filter(
        ([path, flags]) =>
          (path === root || path === join(root, "searxng")) && flags === "r",
      ),
    ).toHaveLength(4);
    expect(directorySyncs).toBe(4);
    expect(directoryCloses).toBe(4);
  });

  it("uses fixed paths below the instance root", () => {
    expect(instancePaths("/opt/argus")).toEqual({
      config: "/opt/argus/argus.yaml",
      secrets: "/opt/argus/secrets.env",
      searxngSecrets: "/opt/argus/searxng/secrets.env",
      state: "/opt/argus/state.json",
    });
  });

  it("persists and loads deployment state atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-instance-"));
    roots.push(root);
    const state: DeploymentStateV1 = {
      schemaVersion: 1,
      argusVersion: "0.1.0",
      composeProject: "argus",
      configHash: "abc123",
      services: { argus: { image: `ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}`, healthy: true } },
      updatedAt: "2026-08-01T00:00:00.000Z",
    };

    await saveDeploymentState(root, state);

    expect(await loadDeploymentState(root)).toEqual(state);
    const mode = (await stat(join(root, "state.json"))).mode & 0o777;
    expect(mode).toBe(0o644);
  });
});
