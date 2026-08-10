import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import type { OnboardingAnswersV1 } from "../src/contracts.js";
import {
  isPinnedImageReference,
  renderCompose,
  renderInstanceConfig,
  renderSearxngSettings,
  writeInstanceFiles,
} from "../src/index.js";

const enabled = process.env.ARGUS_SEARXNG_TEST === "1";
const searxngImage = process.env.ARGUS_SEARXNG_IMAGE;
const clientImage = process.env.ARGUS_SEARXNG_SMOKE_CLIENT_IMAGE;

const prerequisites = async (): Promise<string | undefined> => {
  if (!enabled) return "Set ARGUS_SEARXNG_TEST=1 to opt into this Docker smoke test.";
  if (!searxngImage || !isPinnedImageReference(searxngImage)) {
    return "Set ARGUS_SEARXNG_IMAGE to a validated digest-pinned SearXNG image.";
  }
  if (!clientImage || !isPinnedImageReference(clientImage)) {
    return "Set ARGUS_SEARXNG_SMOKE_CLIENT_IMAGE to a validated digest-pinned HTTP client image.";
  }
  if (
    (
      await execa("docker", ["info"], {
        reject: false,
        timeout: 5_000,
        forceKillAfterDelay: 1_000,
      })
    ).exitCode !== 0
  ) {
    return "Start a reachable Docker daemon before running the managed SearXNG smoke test.";
  }
  for (const image of [searxngImage, clientImage]) {
    if (
      (
        await execa("docker", ["image", "inspect", image], {
          reject: false,
          timeout: 5_000,
          forceKillAfterDelay: 1_000,
        })
      ).exitCode !== 0
    ) {
      return `Pull the required pinned image before running the smoke test: ${image}`;
    }
  }
  return undefined;
};

describe("managed SearXNG live smoke", () => {
  it("serves JSON over the private digest-pinned Compose network", async (context) => {
    const reason = await prerequisites();
    if (reason) return context.skip(reason);
    const pinnedSearxngImage = searxngImage as string;
    const pinnedClientImage = clientImage as string;
    const root = await mkdtemp(join(tmpdir(), "argus-searxng-live-"));
    const project = `argus-searxng-${process.pid}-${Date.now()}`;
    const compose = join(root, "compose.yaml");
    const network = `${project}_argus-private`;
    const answers: OnboardingAnswersV1 = {
      version: 1,
      deployment: {
        provider: "vps-docker",
        root: "/opt/argus",
        storage: "sqlite",
        apiHost: "0.0.0.0",
        apiPort: 8788,
      },
      managed: { searxng: "managed", fxembed: "disabled" },
      watches: [],
      intelligence: { enabled: false, model: "openai/gpt-4.1-mini" },
    };
    const rendered = renderInstanceConfig(answers, {
      searxng: "http://searxng:8080",
      fxembed: "https://fxembed.invalid",
      apiToken: "live-smoke-api-token",
    });
    const composeEnvironment = {
      ...process.env,
      ARGUS_API_PORT: "8788",
      ARGUS_IMAGE: pinnedSearxngImage,
      POSTGRES_IMAGE: pinnedSearxngImage,
      SEARXNG_IMAGE: pinnedSearxngImage,
    };

    await writeInstanceFiles({ root, rendered });
    await writeFile(
      join(root, "searxng", "settings.yml"),
      renderSearxngSettings(),
      "utf8",
    );
    await writeFile(
      compose,
      renderCompose({ version: "0.1.9", storage: "sqlite", searxng: true }),
      "utf8",
    );

    try {
      const config = await execa(
        "docker",
        ["compose", "-p", project, "-f", compose, "config", "--format", "json"],
        {
          env: composeEnvironment,
          timeout: 30_000,
          forceKillAfterDelay: 1_000,
        },
      );
      const parsed = JSON.parse(config.stdout) as {
        services: Record<string, { environment?: Record<string, string> }>;
        networks: Record<string, { internal?: boolean }>;
      };
      expect(config.stdout).toContain(pinnedSearxngImage);
      expect(parsed.networks[`${project}_argus-private`]?.internal).toBe(true);
      expect(Object.keys(parsed.services.searxng?.environment ?? {})).toEqual([
        "SEARXNG_SECRET",
      ]);
      await execa(
        "docker",
        ["compose", "-p", project, "-f", compose, "up", "-d", "searxng"],
        {
          env: composeEnvironment,
          timeout: 30_000,
          forceKillAfterDelay: 1_000,
        },
      );

      let results: unknown;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await execa(
          "docker",
          [
            "run",
            "--rm",
            "--network",
            network,
            pinnedClientImage,
            "-fsS",
            "http://searxng:8080/search?q=argus&format=json",
          ],
          { reject: false, timeout: 10_000, forceKillAfterDelay: 1_000 },
        );
        if (response.exitCode === 0) {
          results = JSON.parse(response.stdout) as { results?: unknown };
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }

      expect(results).toMatchObject({ results: expect.any(Array) });
      expect((results as { results: unknown[] }).results.length).toBeGreaterThan(0);
    } finally {
      await execa(
        "docker",
        ["compose", "-p", project, "-f", compose, "down", "-v"],
        {
          env: composeEnvironment,
          reject: false,
          timeout: 30_000,
          forceKillAfterDelay: 1_000,
        },
      );
      await rm(root, { force: true, recursive: true });
    }
  }, 60_000);
});
