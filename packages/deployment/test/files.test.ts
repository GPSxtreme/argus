import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

  it("uses fixed paths below the instance root", () => {
    expect(instancePaths("/opt/argus")).toEqual({
      config: "/opt/argus/argus.yaml",
      secrets: "/opt/argus/secrets.env",
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
      services: { argus: { image: "argus:latest", healthy: true } },
      updatedAt: "2026-08-01T00:00:00.000Z",
    };

    await saveDeploymentState(root, state);

    expect(await loadDeploymentState(root)).toEqual(state);
    const mode = (await stat(join(root, "state.json"))).mode & 0o777;
    expect(mode).toBe(0o644);
  });
});
