import { createApp } from "@argus/app";
import { validateConfig } from "@argus/config";
import { saveDeploymentState, type CommandExecutor, type OnboardingAnswersV1 } from "@argus/deployment";
import { buildReleaseArtifacts } from "@argus/release";
import { createSqliteRepository } from "@argus/storage-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInstalledConfigIntegration,
  createProductionOnboardingIntegration,
  createProductionUpdateIntegration,
  createReleaseComposition,
} from "../src/integrations.js";
import { createNodeCliDependencies } from "../src/program.js";
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

  it("stops streaming immediately after the installed-config response exceeds its cap", async () => {
    let pulls = 0;
    let cancelled = false;
    const integration = createInstalledConfigIntegration({
      endpoint: "http://argus.local",
      token: "secret",
      timeoutMs: 100,
      fetcher: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls += 1;
              controller.enqueue(new Uint8Array(600 * 1024));
            },
            cancel() {
              cancelled = true;
              return new Promise<void>(() => undefined);
            },
          }),
        ),
    });

    await expect(
      integration.inspect({ path: "/opt/argus/argus.yaml", config }),
    ).rejects.toMatchObject({ code: "CONFIG_SERVICE_RESPONSE_INVALID" });
    expect(pulls).toBeLessThanOrEqual(3);
    expect(cancelled).toBe(true);
  });

  it("cleans up its deadline timer and absorbs a late body rejection", async () => {
    vi.useFakeTimers();
    try {
      let rejectRead: ((reason?: unknown) => void) | undefined;
      const integration = createInstalledConfigIntegration({
        endpoint: "http://argus.local",
        token: "secret",
        timeoutMs: 5,
        fetcher: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull: () =>
                new Promise<void>((_resolve, reject) => {
                  rejectRead = reject;
                }),
            }),
          ),
      });
      const inspection = integration.inspect({
        path: "/opt/argus/argus.yaml",
        config,
      });
      const rejection = expect(inspection).rejects.toMatchObject({
        code: "CONFIG_SERVICE_REQUEST_FAILED",
      });
      await vi.advanceTimersByTimeAsync(5);
      await rejection;
      rejectRead?.(new Error("late body failure"));
      await vi.runAllTimersAsync();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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

const releaseFixture = ({
  version = "1.2.3",
  appMarker = "a",
  fxembedMarker = "default",
}: { version?: string; appMarker?: string; fxembedMarker?: string } = {}) => {
  const fxembed = Buffer.from(`export default { fetch() {} }; // ${fxembedMarker}\n`);
  const wrapper = Buffer.from("#!/bin/sh\nexec true\n");
  const built = buildReleaseArtifacts({
    version,
    sourceDateEpoch: "1785580200",
    images: [
      { name: "app", reference: `ghcr.io/gpsxtreme/argus@sha256:${digest(appMarker)}` },
      { name: "cli", reference: `ghcr.io/gpsxtreme/argus-cli@sha256:${digest("b")}` },
      { name: "searxng", reference: `docker.io/searxng/searxng@sha256:${digest("c")}` },
      { name: "postgres", reference: `docker.io/library/postgres@sha256:${digest("d")}` },
    ],
    fxembed: {
      bytes: fxembed,
      url: `https://release.example/v${version}/fxembed.js`,
      compatibilityDate: "2026-04-11",
    },
    wrapper: { bytes: wrapper, url: `https://release.example/v${version}/argus` },
    installer: { bytes: Buffer.from("installer"), url: `https://release.example/v${version}/install.sh` },
    publicKeyUrl: `https://release.example/v${version}/release-public.pem`,
    fxembedLicense: { bytes: Buffer.from("MIT"), url: `https://release.example/v${version}/FXEMBED-LICENSE.md` },
    fxembedProvenance: {
      bytes: Buffer.from("{}"),
      url: `https://release.example/v${version}/fxembed-provenance.json`,
    },
    privateKeyPem: fixturePrivateKey,
  });
  return { ...built, fxembed, version };
};

const saveManagedState = async (
  root: string,
  fixture: ReturnType<typeof releaseFixture>,
): Promise<void> => {
  const images = JSON.parse(Buffer.from(fixture.manifestBytes).toString("utf8")).images;
  await saveDeploymentState(root, {
    schemaVersion: 1,
    argusVersion: fixture.version,
    composeProject: "argus",
    configHash: digest("f"),
    services: { argus: { image: images.app.reference, healthy: true } },
    compose: {
      version: fixture.version,
      apiPort: 8788,
      storage: "sqlite",
      searxng: false,
      images: {
        argus: images.app.reference,
        postgres: images.postgres.reference,
        searxng: images.searxng.reference,
      },
    },
    updatedAt: "2026-08-01T00:00:00.000Z",
  });
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
      updateIntegration: expect.objectContaining({
        fetchUpdateRelease: expect.any(Function),
        fetchRollbackRelease: expect.any(Function),
        stageCurrentRelease: expect.any(Function),
        promoteCurrentRelease: expect.any(Function),
      }),
    });
  });

  it("fetches and verifies the exact signed update manifest before exposing it", async () => {
    const fixture = releaseFixture();
    const composition = createReleaseComposition({
      root: "/opt/argus",
      executor: new DeploymentExecutor(),
      environment: {
        ARGUS_RELEASE_PUBLIC_KEY_B64: Buffer.from(fixture.publicKeyPem).toString("base64"),
        ARGUS_RELEASE_MANIFEST_URL: "https://release.example/manifest.json",
      },
      fetcher: async (input) => {
        const url = String(input);
        const bytes = url.endsWith(".sig")
          ? fixture.signature
          : url.endsWith("fxembed.js")
            ? fixture.fxembed
            : fixture.manifestBytes;
        return new Response(Uint8Array.from(bytes).buffer);
      },
    });

    await expect(composition.updateIntegration?.fetchUpdateRelease()).resolves.toMatchObject({
      manifest: { version: "1.2.3" },
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it("promotes the verified target context only after success so the next update rolls back to it", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-update-context-"));
    const releaseA = releaseFixture({ version: "1.0.0", appMarker: "a" });
    const releaseB = releaseFixture({ version: "2.0.0", appMarker: "b" });
    const releaseC = releaseFixture({ version: "3.0.0", appMarker: "c" });
    await writeFile(
      join(root, "release-context.json"),
      JSON.stringify({
        schemaVersion: 1,
        manifest: Buffer.from(releaseA.manifestBytes).toString("base64"),
        signature: Buffer.from(releaseA.signature).toString("base64"),
        fxembed: Buffer.from(releaseA.fxembed).toString("base64"),
      }),
    );
    let target = releaseB;
    const integration = createProductionUpdateIntegration({
      root,
      manifestUrl: "https://release.example/manifest.json",
      publicKeyPem: releaseA.publicKeyPem,
      fetcher: async (input) => {
        const url = String(input);
        const bytes = url.endsWith("manifest.sig")
          ? target.signature
          : url.endsWith("manifest.json")
            ? target.manifestBytes
            : url === `https://release.example/v${target.version}/fxembed.js`
              ? target.fxembed
              : undefined;
        return bytes === undefined
          ? new Response(null, { status: 404 })
          : new Response(Uint8Array.from(bytes).buffer);
      },
    });

    const verifiedB = await integration.fetchUpdateRelease();
    await integration.stageCurrentRelease(verifiedB);
    await integration.promoteCurrentRelease(verifiedB);
    target = releaseC;
    await expect(integration.fetchUpdateRelease()).resolves.toMatchObject({ manifest: { version: "3.0.0" } });
    await expect(integration.fetchRollbackRelease()).resolves.toMatchObject({ manifest: { version: "2.0.0" } });
  });

  it("recovers an interrupted context promotion when the staged release matches deployment state", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-update-recovery-"));
    const releaseA = releaseFixture({ version: "1.0.0", appMarker: "a" });
    const releaseB = releaseFixture({ version: "2.0.0", appMarker: "b" });
    const contextFor = (fixture: ReturnType<typeof releaseFixture>) => JSON.stringify({
      schemaVersion: 1,
      manifest: Buffer.from(fixture.manifestBytes).toString("base64"),
      signature: Buffer.from(fixture.signature).toString("base64"),
      fxembed: Buffer.from(fixture.fxembed).toString("base64"),
    });
    await writeFile(join(root, "release-context.json"), contextFor(releaseA));
    await writeFile(join(root, "release-context.pending.json"), contextFor(releaseB));
    await saveManagedState(root, releaseB);
    const integration = createProductionUpdateIntegration({
      root,
      manifestUrl: "https://release.example/manifest.json",
      publicKeyPem: releaseA.publicKeyPem,
      fetcher: async () => new Response(null, { status: 404 }),
    });

    await expect(integration.fetchRollbackRelease()).resolves.toMatchObject({ manifest: { version: "2.0.0" } });
    expect(await readFile(join(root, "release-context.json"), "utf8")).toBe(contextFor(releaseB));
  });

  it("stages the target before apply and promotes it only after healthy update verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-update-order-"));
    const current = releaseFixture({ version: "1.0.0", appMarker: "a" });
    const target = releaseFixture({ version: "2.0.0", appMarker: "b" });
    const context = JSON.stringify({
      schemaVersion: 1,
      manifest: Buffer.from(current.manifestBytes).toString("base64"),
      signature: Buffer.from(current.signature).toString("base64"),
      fxembed: Buffer.from(current.fxembed).toString("base64"),
    });
    await writeFile(join(root, "release-context.json"), context);
    await saveManagedState(root, current);
    const signed = createProductionUpdateIntegration({
      root,
      manifestUrl: "https://release.example/manifest.json",
      publicKeyPem: current.publicKeyPem,
      fetcher: async (input) => {
        const url = String(input);
        const bytes = url.endsWith("manifest.sig")
          ? target.signature
          : url.endsWith("manifest.json")
            ? target.manifestBytes
            : url === `https://release.example/v${target.version}/fxembed.js`
              ? target.fxembed
              : undefined;
        return bytes === undefined
          ? new Response(null, { status: 404 })
          : new Response(Uint8Array.from(bytes).buffer);
      },
    });
    const targetRelease = await signed.fetchUpdateRelease();
    const currentRelease = await signed.fetchRollbackRelease();
    const events: string[] = [];
    const dependencies = createNodeCliDependencies({
      root,
      executor: {
        async run(_command, args) {
          if (args.includes("pull")) events.push("pull");
          if (args.includes("migrate")) events.push("migrate");
          if (args.includes("up")) events.push("up");
          if (args.includes("ps")) {
            events.push("healthy");
            return { exitCode: 0, stdout: '[{"Service":"argus","State":"running","Health":"healthy"}]', stderr: "" };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      prompt: {
        async confirm() { return true; },
        async select() { return ""; },
        async multiselect() { return []; },
        async text() { return ""; },
        async secret() { return ""; },
      },
      io: { stdout() {}, stderr() {} },
      updateIntegration: {
        async fetchUpdateRelease() { return targetRelease; },
        async fetchRollbackRelease() { return currentRelease; },
        async stageCurrentRelease() { events.push("stage"); },
        async promoteCurrentRelease() { events.push("promote"); },
      },
      version: "test",
    });

    const plan = await dependencies.deployment.inspectUpdate?.();
    await dependencies.deployment.applyUpdate?.(plan);
    expect(events).toEqual(["stage", "pull", "migrate", "up", "healthy", "promote"]);
  });

  it("rejects an unhealthy no-op without promoting a different signed target context", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-update-noop-"));
    const current = releaseFixture({ version: "1.0.0", appMarker: "a" });
    const target = releaseFixture({ version: "1.0.0", appMarker: "a", fxembedMarker: "target" });
    const context = JSON.stringify({
      schemaVersion: 1,
      manifest: Buffer.from(current.manifestBytes).toString("base64"),
      signature: Buffer.from(current.signature).toString("base64"),
      fxembed: Buffer.from(current.fxembed).toString("base64"),
    });
    await writeFile(join(root, "release-context.json"), context);
    await saveManagedState(root, current);
    const updateIntegration = createProductionUpdateIntegration({
      root,
      manifestUrl: "https://release.example/manifest.json",
      publicKeyPem: current.publicKeyPem,
      fetcher: async (input) => {
        const url = String(input);
        const bytes = url.endsWith("manifest.sig")
          ? target.signature
          : url.endsWith("manifest.json")
            ? target.manifestBytes
            : url === `https://release.example/v${target.version}/fxembed.js`
              ? target.fxembed
              : undefined;
        return bytes === undefined
          ? new Response(null, { status: 404 })
          : new Response(Uint8Array.from(bytes).buffer);
      },
    });
    const dependencies = createNodeCliDependencies({
      root,
      executor: {
        async run(_command, args) {
          return args.includes("ps")
            ? { exitCode: 0, stdout: "[]", stderr: "" }
            : { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      prompt: {
        async confirm() { return true; },
        async select() { return ""; },
        async multiselect() { return []; },
        async text() { return ""; },
        async secret() { return ""; },
      },
      io: { stdout() {}, stderr() {} },
      updateIntegration,
      version: "test",
    });

    const plan = await dependencies.deployment.inspectUpdate?.();
    expect((plan as { noop: boolean }).noop).toBe(true);
    await expect(dependencies.deployment.applyUpdate?.(plan)).rejects.toMatchObject({
      code: "UPDATE_HEALTHCHECK_FAILED",
    });
    expect(await readFile(join(root, "release-context.json"), "utf8")).toBe(context);
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
