import { createApp } from "@argus/app";
import { validateConfig } from "@argus/config";
import type { CommandExecutor, OnboardingAnswersV1 } from "@argus/deployment";
import { buildReleaseArtifacts } from "@argus/release";
import { createSqliteRepository } from "@argus/storage-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createInstalledConfigIntegration,
  createProductionOnboardingIntegration,
  createReleaseComposition,
} from "../src/integrations.js";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repositories: Awaited<ReturnType<typeof createSqliteRepository>>[] = [];
afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
});

const config = validateConfig({
  version: 1,
  storage: { adapter: "sqlite", url: "/app/data/argus.db" },
  sources: {},
  watches: [],
  api: { token: "secret" },
});

describe("installed config integration", () => {
  it("uses the authenticated service boundary and rejects a stale exact plan", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const app = createApp({ config, repository });
    const fetcher: typeof fetch = async (input, init) =>
      app.request(new Request(input, init));
    const integration = createInstalledConfigIntegration({
      endpoint: "http://argus.local",
      token: "secret",
      fetcher,
    });

    const inspection = await integration.inspect({
      path: "/opt/argus/argus.yaml",
      config,
    });
    expect(inspection).toMatchObject({
      contractVersion: 1,
      path: "/opt/argus/argus.yaml",
      operations: [{ resource: "applied-config", action: "create" }],
    });
    expect(inspection.planId).toMatch(/^[a-f0-9]{64}$/u);
    expect(inspection.desiredContentHash).toMatch(/^[a-f0-9]{64}$/u);

    const application = await integration.apply({
      path: "/opt/argus/argus.yaml",
      config,
      inspection,
    });
    await expect(
      integration.verify({
        path: "/opt/argus/argus.yaml",
        inspection,
        application,
      }),
    ).resolves.toMatchObject({ healthy: true, planId: inspection.planId });
    await expect(
      integration.apply({
        path: "/opt/argus/argus.yaml",
        config,
        inspection,
      }),
    ).rejects.toMatchObject({ code: "CONFIG_SERVICE_PLAN_STALE" });
  });

  it("fails closed when the in-service API rejects authentication", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const app = createApp({ config, repository });
    const integration = createInstalledConfigIntegration({
      endpoint: "http://argus.local",
      token: "wrong",
      fetcher: async (input, init) => app.request(new Request(input, init)),
    });

    await expect(
      integration.inspect({
        path: "/opt/argus/argus.yaml",
        config,
      }),
    ).rejects.toMatchObject({ code: "CONFIG_SERVICE_UNAUTHORIZED" });
  });
});

const fixturePrivateKey = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIGJqC73Ezwmnx3FFQ5W1czmiNwXmLFn2Xso+6xXKPXKf
-----END PRIVATE KEY-----`;
const digest = (character: string): string => character.repeat(64);
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

class DeploymentExecutor implements CommandExecutor {
  running = false;
  async run(_command: string, args: string[]) {
    if (args.includes("up")) this.running = true;
    if (args.at(-1) === "json") {
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          this.running
            ? [
                { Service: "argus", State: "running", Health: "healthy" },
                { Service: "searxng", State: "running", Health: "healthy" },
              ]
            : [],
        ),
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

const releaseFixture = () => {
  const fxembed = Buffer.from("export default { fetch() {} };\n");
  const wrapper = Buffer.from("#!/bin/sh\nexec true\n");
  const built = buildReleaseArtifacts({
    version: "1.2.3",
    sourceDateEpoch: "1785580200",
    images: [
      { name: "app", reference: `ghcr.io/gpsxtreme/argus@sha256:${digest("a")}` },
      { name: "cli", reference: `ghcr.io/gpsxtreme/argus-cli@sha256:${digest("b")}` },
      { name: "searxng", reference: `docker.io/searxng/searxng@sha256:${digest("c")}` },
      { name: "postgres", reference: `docker.io/library/postgres@sha256:${digest("d")}` },
    ],
    fxembed: {
      bytes: fxembed,
      url: "https://release.example/v1.2.3/fxembed.js",
      compatibilityDate: "2026-04-11",
    },
    wrapper: { bytes: wrapper, url: "https://release.example/v1.2.3/argus" },
    installer: { bytes: Buffer.from("installer"), url: "https://release.example/v1.2.3/install.sh" },
    publicKeyUrl: "https://release.example/v1.2.3/release-public.pem",
    fxembedLicense: { bytes: Buffer.from("MIT"), url: "https://release.example/v1.2.3/FXEMBED-LICENSE.md" },
    fxembedProvenance: {
      bytes: Buffer.from("{}"),
      url: "https://release.example/v1.2.3/fxembed-provenance.json",
    },
    privateKeyPem: fixturePrivateKey,
  });
  return { ...built, fxembed };
};

describe("production onboarding integration", () => {
  it("composes both concrete integrations from embedded release and installed API inputs", () => {
    const fixture = releaseFixture();
    expect(
      createReleaseComposition({
        root: "/opt/argus",
        executor: new DeploymentExecutor(),
        environment: {
          ARGUS_RELEASE_PUBLIC_KEY_B64: Buffer.from(
            fixture.publicKeyPem,
          ).toString("base64"),
          ARGUS_RELEASE_MANIFEST_URL:
            "https://release.example/manifest.json",
        },
        apiToken: "secret",
        apiPort: 8788,
      }),
    ).toMatchObject({
      onboardingIntegration: expect.objectContaining({
        inspect: expect.any(Function),
        apply: expect.any(Function),
        verify: expect.any(Function),
      }),
      installedConfigIntegration: expect.objectContaining({
        inspect: expect.any(Function),
        apply: expect.any(Function),
        verify: expect.any(Function),
      }),
    });
  });

  it("verifies assets, applies one exact plan, and reverifies persisted signed context", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-release-integration-"));
    const fixture = releaseFixture();
    const responses = new Map<string, Uint8Array>([
      ["https://release.example/manifest.json", fixture.manifestBytes],
      ["https://release.example/manifest.sig", fixture.signature],
      ["https://release.example/v1.2.3/fxembed.js", fixture.fxembed],
    ]);
    const integration = createProductionOnboardingIntegration({
      root,
      executor: new DeploymentExecutor(),
      manifestUrl: "https://release.example/manifest.json",
      publicKeyPem: fixture.publicKeyPem,
      fetcher: async (input) => {
        const bytes = responses.get(String(input));
        return bytes === undefined
          ? new Response(null, { status: 404 })
          : new Response(Uint8Array.from(bytes).buffer);
      },
    });
    const secrets = { ARGUS_API_TOKEN: "must-not-leak" };
    const inspection = await integration.inspect({ answers, secrets });
    const application = await integration.apply({
      answers,
      secrets,
      inspection,
    });
    expect(application).toMatchObject({
      release: inspection.release,
      stateWritten: true,
    });
    expect(await integration.verify({ answers, application })).toMatchObject({
      healthy: true,
      release: inspection.release,
    });
    const context = await readFile(join(root, "release-context.json"), "utf8");
    expect(context).not.toContain("must-not-leak");
    expect(
      Buffer.from(JSON.parse(context).manifest, "base64").equals(
        Buffer.from(fixture.manifestBytes),
      ),
    ).toBe(true);

    const corrupted = JSON.parse(context);
    corrupted.signature = Buffer.alloc(64).toString("base64");
    await writeFile(join(root, "release-context.json"), JSON.stringify(corrupted));
    await expect(
      integration.verify({ answers, application }),
    ).rejects.toMatchObject({ code: "RELEASE_SIGNATURE_INVALID" });
  });

  it("rejects bad signatures and FxEmbed hashes before mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-release-invalid-"));
    const fixture = releaseFixture();
    let signature = fixture.signature;
    let fxembed = fixture.fxembed;
    const integration = createProductionOnboardingIntegration({
      root,
      executor: new DeploymentExecutor(),
      manifestUrl: "https://release.example/manifest.json",
      publicKeyPem: fixture.publicKeyPem,
      fetcher: async (input) => {
        if (String(input).endsWith("manifest.json")) {
          return new Response(Uint8Array.from(fixture.manifestBytes).buffer);
        }
        if (String(input).endsWith("manifest.sig")) {
          return new Response(Uint8Array.from(signature).buffer);
        }
        return new Response(Uint8Array.from(fxembed).buffer);
      },
    });
    signature = Buffer.alloc(64);
    await expect(
      integration.inspect({ answers, secrets: {} }),
    ).rejects.toMatchObject({ code: "RELEASE_SIGNATURE_INVALID" });
    signature = fixture.signature;
    fxembed = Buffer.from("tampered");
    await expect(
      integration.inspect({ answers, secrets: {} }),
    ).rejects.toMatchObject({ code: "RELEASE_ASSET_HASH_MISMATCH" });
    await expect(readFile(join(root, "release-context.json"))).rejects.toThrow();
  });

  it("enforces a hard deadline on release downloads", async () => {
    const fixture = releaseFixture();
    const integration = createProductionOnboardingIntegration({
      root: "/opt/argus",
      executor: new DeploymentExecutor(),
      manifestUrl: "https://release.example/manifest.json",
      publicKeyPem: fixture.publicKeyPem,
      timeoutMs: 5,
      fetcher: async (input) => {
        if (String(input).endsWith("manifest.sig")) {
          return new Response(Uint8Array.from(fixture.signature).buffer);
        }
        return await new Promise<Response>(() => undefined);
      },
    });

    await expect(
      integration.inspect({ answers, secrets: {} }),
    ).rejects.toMatchObject({ code: "RELEASE_MANIFEST_DOWNLOAD_FAILED" });
  });

  it("enforces the deadline while an abort-ignoring response body hangs", async () => {
    const fixture = releaseFixture();
    const integration = createProductionOnboardingIntegration({
      root: "/opt/argus",
      executor: new DeploymentExecutor(),
      manifestUrl: "https://release.example/manifest.json",
      publicKeyPem: fixture.publicKeyPem,
      timeoutMs: 5,
      fetcher: async () =>
        new Response(new ReadableStream<Uint8Array>({ pull: async () => await new Promise(() => undefined) })),
    });
    await expect(
      integration.inspect({ answers, secrets: {} }),
    ).rejects.toMatchObject({ code: "RELEASE_MANIFEST_DOWNLOAD_FAILED" });
  });
});
