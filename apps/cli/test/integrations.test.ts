import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@argus/app";
import { validateConfig } from "@argus/config";
import { type CommandExecutor, type OnboardingAnswersV1, saveDeploymentState } from "@argus/deployment";
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

const updateEventCapture = vi.hoisted(() => ({
  events: undefined as string[] | undefined,
}));

vi.mock("@argus/deployment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argus/deployment")>();
  return {
    ...actual,
    applyUpdate: async (input: Parameters<typeof actual.applyUpdate>[0]) => {
      updateEventCapture.events?.push("backup");
      const result = await actual.applyUpdate(input);
      updateEventCapture.events?.push("save-deployment-state");
      return result;
    },
  };
});

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
const stableUpdateManifestUrl = "https://argus.gpsxtre.me/releases/stable/manifest.json";
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
  releaseBaseUrl = `https://release.example/v${version}`,
}: {
  version?: string;
  appMarker?: string;
  fxembedMarker?: string;
  releaseBaseUrl?: string;
} = {}) => {
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
      url: `${releaseBaseUrl}/fxembed.js`,
      compatibilityDate: "2026-04-11",
    },
    wrapper: { bytes: wrapper, url: `${releaseBaseUrl}/argus` },
    installer: { bytes: Buffer.from("installer"), url: `${releaseBaseUrl}/install.sh` },
    publicKeyUrl: `${releaseBaseUrl}/release-public.pem`,
    fxembedLicense: { bytes: Buffer.from("MIT"), url: `${releaseBaseUrl}/FXEMBED-LICENSE.md` },
    fxembedProvenance: {
      bytes: Buffer.from("{}"),
      url: `${releaseBaseUrl}/fxembed-provenance.json`,
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
  it("uses the protected GHCR token only for exact Argus GitHub release URLs and strips it on redirects", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-release-auth-"));
    const releaseBaseUrl =
      "https://github.com/GPSxtreme/argus/releases/download/v1.2.3";
    const fixture = releaseFixture({ releaseBaseUrl });
    const token = "github_pat_private_release_fixture";
    await mkdir(join(root, ".docker"), { recursive: true });
    await writeFile(
      join(root, ".docker", "config.json"),
      JSON.stringify({
        auths: {
          "ghcr.io": {
            auth: Buffer.from(`GPSxtreme:${token}`).toString("base64"),
          },
        },
      }),
      { mode: 0o600 },
    );
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const integration = createProductionOnboardingIntegration({
      root,
      executor: new DeploymentExecutor(),
      manifestUrl: `${releaseBaseUrl}/manifest.json`,
      publicKeyPem: fixture.publicKeyPem,
      fetcher: async (input, init) => {
        const url = String(input);
        requests.push({
          url,
          authorization: new Headers(init?.headers).get("authorization"),
        });
        if (url.endsWith("/fxembed.js")) {
          return new Response(null, {
            status: 302,
            headers: {
              location:
                "https://api.github.com/repos/GPSxtreme/argus/releases/assets/123",
            },
          });
        }
        if (
          url ===
          "https://api.github.com/repos/GPSxtreme/argus/releases/assets/123"
        ) {
          return new Response(null, {
            status: 302,
            headers: {
              location:
                "https://release-assets.githubusercontent.com/github-production-release-asset/fixture",
            },
          });
        }
        if (url.includes("release-assets.githubusercontent.com")) {
          return new Response(Uint8Array.from(fixture.fxembed).buffer);
        }
        const bytes = url.endsWith("manifest.sig")
          ? fixture.signature
          : fixture.manifestBytes;
        return new Response(Uint8Array.from(bytes).buffer);
      },
    });

    await expect(
      integration.inspect({ answers, secrets: {} }),
    ).resolves.toMatchObject({ release: { version: "1.2.3" } });
    expect(
      requests
        .filter(({ url }) => url.startsWith(releaseBaseUrl))
        .map(({ authorization }) => authorization),
    ).toEqual([`Bearer ${token}`, `Bearer ${token}`, `Bearer ${token}`]);
    expect(
      requests.find(({ url }) =>
        url.includes("release-assets.githubusercontent.com"),
      )?.authorization,
    ).toBeNull();
    expect(
      requests.find(({ url }) => url.startsWith("https://api.github.com"))
        ?.authorization,
    ).toBe(`Bearer ${token}`);
  });

  it("keeps public release requests unauthenticated when no GHCR credential exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-release-public-"));
    const fixture = releaseFixture();
    const authorizations: Array<string | null> = [];
    const integration = createProductionOnboardingIntegration({
      root,
      executor: new DeploymentExecutor(),
      manifestUrl: "https://release.example/manifest.json",
      publicKeyPem: fixture.publicKeyPem,
      fetcher: async (input, init) => {
        authorizations.push(
          new Headers(init?.headers).get("authorization"),
        );
        const url = String(input);
        const bytes = url.endsWith("manifest.sig")
          ? fixture.signature
          : url.endsWith("fxembed.js")
            ? fixture.fxembed
            : fixture.manifestBytes;
        return new Response(Uint8Array.from(bytes).buffer);
      },
    });

    await integration.inspect({ answers, secrets: {} });
    expect(authorizations).toEqual([null, null, null]);
  });

  it("authenticates a trusted private release asset discovered by the public update channel", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-update-auth-"));
    const releaseBaseUrl =
      "https://github.com/GPSxtreme/argus/releases/download/v1.2.3";
    const fixture = releaseFixture({ releaseBaseUrl });
    const token = "github_pat_update_fixture";
    await mkdir(join(root, ".docker"), { recursive: true });
    await writeFile(
      join(root, ".docker", "config.json"),
      JSON.stringify({
        auths: {
          "ghcr.io": {
            auth: Buffer.from(`GPSxtreme:${token}`).toString("base64"),
          },
        },
      }),
      { mode: 0o600 },
    );
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const integration = createProductionUpdateIntegration({
      root,
      manifestUrl: stableUpdateManifestUrl,
      publicKeyPem: fixture.publicKeyPem,
      fetcher: async (input, init) => {
        const url = String(input);
        requests.push({
          url,
          authorization: new Headers(init?.headers).get("authorization"),
        });
        const bytes = url.endsWith("manifest.sig")
          ? fixture.signature
          : url.endsWith("fxembed.js")
            ? fixture.fxembed
            : fixture.manifestBytes;
        return new Response(Uint8Array.from(bytes).buffer);
      },
    });

    await integration.fetchUpdateRelease();
    expect(requests).toEqual([
      { url: stableUpdateManifestUrl, authorization: null },
      {
        url: "https://argus.gpsxtre.me/releases/stable/manifest.sig",
        authorization: null,
      },
      {
        url: `${releaseBaseUrl}/fxembed.js`,
        authorization: `Bearer ${token}`,
      },
    ]);
  });

  it.each([
    ["invalid JSON", "{", "not-a-secret"],
    [
      "non-canonical base64",
      JSON.stringify({ auths: { "ghcr.io": { auth: "!!!!" } } }),
      "not-a-secret",
    ],
    [
      "credential without a password",
      JSON.stringify({
        auths: {
          "ghcr.io": {
            auth: Buffer.from("GPSxtreme").toString("base64"),
          },
        },
      }),
      "not-a-secret",
    ],
    [
      "credential containing a newline",
      JSON.stringify({
        auths: {
          "ghcr.io": {
            auth: Buffer.from("GPSxtreme:must-not-leak\n").toString("base64"),
          },
        },
      }),
      "must-not-leak",
    ],
  ])("rejects %s in the Docker credential without leaking it", async (
    _case,
    configContents,
    secret,
  ) => {
    const root = await mkdtemp(join(tmpdir(), "argus-release-bad-auth-"));
    const releaseBaseUrl =
      "https://github.com/GPSxtreme/argus/releases/download/v1.2.3";
    const fixture = releaseFixture({ releaseBaseUrl });
    await mkdir(join(root, ".docker"), { recursive: true });
    await writeFile(join(root, ".docker", "config.json"), configContents, {
      mode: 0o600,
    });
    const fetcher = vi.fn<typeof fetch>();
    const integration = createProductionOnboardingIntegration({
      root,
      executor: new DeploymentExecutor(),
      manifestUrl: `${releaseBaseUrl}/manifest.json`,
      publicKeyPem: fixture.publicKeyPem,
      fetcher,
    });

    const failure = await integration
      .inspect({ answers, secrets: {} })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "RELEASE_CREDENTIAL_INVALID" });
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not send the GHCR token to lookalike GitHub repositories or hosts", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-release-scope-"));
    const token = "must-not-leak";
    await mkdir(join(root, ".docker"), { recursive: true });
    await writeFile(
      join(root, ".docker", "config.json"),
      JSON.stringify({
        auths: {
          "ghcr.io": {
            auth: Buffer.from(`GPSxtreme:${token}`).toString("base64"),
          },
        },
      }),
      { mode: 0o600 },
    );
    const fixture = releaseFixture();
    const authorizations: Array<string | null> = [];
    const integration = createProductionOnboardingIntegration({
      root,
      executor: new DeploymentExecutor(),
      manifestUrl:
        "https://github.com/attacker/argus/releases/download/v1.2.3/manifest.json",
      publicKeyPem: fixture.publicKeyPem,
      fetcher: async (input, init) => {
        authorizations.push(
          new Headers(init?.headers).get("authorization"),
        );
        const url = String(input);
        const bytes = url.endsWith("manifest.sig")
          ? fixture.signature
          : url.endsWith("fxembed.js")
            ? fixture.fxembed
            : fixture.manifestBytes;
        return new Response(Uint8Array.from(bytes).buffer);
      },
    });

    await integration.inspect({ answers, secrets: {} });
    expect(authorizations).toEqual([null, null, null]);
  });

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
          ARGUS_UPDATE_MANIFEST_URL: stableUpdateManifestUrl,
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
        promoteManagementRelease: expect.any(Function),
      }),
    });
  });

  it("keeps onboarding pinned while fetching updates from the stable signed channel", async () => {
    const fixture = releaseFixture();
    const requests: string[] = [];
    const composition = createReleaseComposition({
      root: "/opt/argus",
      executor: new DeploymentExecutor(),
      environment: {
        ARGUS_RELEASE_PUBLIC_KEY_B64: Buffer.from(fixture.publicKeyPem).toString("base64"),
        ARGUS_RELEASE_MANIFEST_URL: "https://release.example/manifest.json",
        ARGUS_UPDATE_MANIFEST_URL: stableUpdateManifestUrl,
      },
      fetcher: async (input) => {
        const url = String(input);
        requests.push(url);
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
    await expect(composition.onboardingIntegration?.inspect({ answers, secrets: {} })).resolves.toMatchObject({
      release: { version: "1.2.3" },
    });
    expect(requests).toEqual(expect.arrayContaining([
      stableUpdateManifestUrl,
      "https://argus.gpsxtre.me/releases/stable/manifest.sig",
      "https://release.example/manifest.json",
      "https://release.example/manifest.sig",
    ]));
  });

  it("fails closed when the update channel boundary is missing or not canonical", () => {
    const fixture = releaseFixture();
    const environment = {
      ARGUS_RELEASE_PUBLIC_KEY_B64: Buffer.from(fixture.publicKeyPem).toString("base64"),
      ARGUS_RELEASE_MANIFEST_URL: "https://release.example/v1.2.3/manifest.json",
    };

    expect(() => createReleaseComposition({
      root: "/opt/argus",
      executor: new DeploymentExecutor(),
      environment,
    })).toThrow(expect.objectContaining({ code: "RELEASE_COMPOSITION_INVALID" }));
    expect(() => createReleaseComposition({
      root: "/opt/argus",
      executor: new DeploymentExecutor(),
      environment: {
        ...environment,
        ARGUS_UPDATE_MANIFEST_URL: "https://release.example/v1.2.3/manifest.json",
      },
    })).toThrow(expect.objectContaining({ code: "RELEASE_COMPOSITION_INVALID" }));
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

  it("orders signed-context and management-state promotion after durable healthy update state", async () => {
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
          if (args.includes("up")) events.push("reconcile");
          if (args.includes("ps")) {
            events.push("health");
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
        async stageCurrentRelease() { events.push("stage-release-context"); },
        async promoteCurrentRelease() { events.push("promote-release-context"); },
        async promoteManagementRelease() { events.push("promote-management-state"); },
      },
      version: "test",
    });

    const plan = await dependencies.deployment.inspectUpdate?.();
    updateEventCapture.events = events;
    try {
      await dependencies.deployment.applyUpdate?.(plan);
    } finally {
      updateEventCapture.events = undefined;
    }
    expect(events).toEqual([
      "stage-release-context",
      "backup",
      "pull",
      "migrate",
      "reconcile",
      "health",
      "save-deployment-state",
      "promote-release-context",
      "promote-management-state",
    ]);
  });

  it("writes management state only from the exact fetched verified release", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-update-management-state-"));
    const fixture = releaseFixture({ version: "2.0.0" });
    const integration = createProductionUpdateIntegration({
      root,
      manifestUrl: "https://release.example/manifest.json",
      publicKeyPem: fixture.publicKeyPem,
      fetcher: async (input) => {
        const url = String(input);
        const bytes = url.endsWith("manifest.sig")
          ? fixture.signature
          : url.endsWith("manifest.json")
            ? fixture.manifestBytes
            : fixture.fxembed;
        return new Response(Uint8Array.from(bytes).buffer);
      },
    });

    const release = await integration.fetchUpdateRelease();
    await integration.promoteManagementRelease(release);

    expect(await readFile(join(root, "management.state"), "utf8")).toBe(
      `schema=1\nversion=2.0.0\ncli_image=ghcr.io/gpsxtreme/argus-cli@sha256:${digest("b")}\n`,
    );
    await expect(
      integration.promoteManagementRelease({ ...release, manifestSha256: digest("other") }),
    ).rejects.toMatchObject({ code: "UPDATE_RELEASE_UNVERIFIED" });
  });

  it("repairs stale management state for a healthy no-op update", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-update-management-noop-"));
    const current = releaseFixture({ version: "1.0.0", appMarker: "a" });
    const stale = releaseFixture({ version: "0.9.0", appMarker: "a" });
    const context = JSON.stringify({
      schemaVersion: 1,
      manifest: Buffer.from(current.manifestBytes).toString("base64"),
      signature: Buffer.from(current.signature).toString("base64"),
      fxembed: Buffer.from(current.fxembed).toString("base64"),
    });
    await writeFile(join(root, "release-context.json"), context);
    await saveManagedState(root, current);
    await writeFile(
      join(root, "management.state"),
      `schema=1\nversion=${stale.version}\ncli_image=ghcr.io/gpsxtreme/argus-cli@sha256:${digest("b")}\n`,
    );
    const updateIntegration = createProductionUpdateIntegration({
      root,
      manifestUrl: "https://release.example/manifest.json",
      publicKeyPem: current.publicKeyPem,
      fetcher: async (input) => {
        const url = String(input);
        const bytes = url.endsWith("manifest.sig")
          ? current.signature
          : url.endsWith("manifest.json")
            ? current.manifestBytes
            : current.fxembed;
        return new Response(Uint8Array.from(bytes).buffer);
      },
    });
    const dependencies = createNodeCliDependencies({
      root,
      executor: {
        async run(_command, args) {
          return args.includes("ps")
            ? { exitCode: 0, stdout: '[{"Service":"argus","State":"running","Health":"healthy"}]', stderr: "" }
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
    await dependencies.deployment.applyUpdate?.(plan);
    expect(await readFile(join(root, "management.state"), "utf8")).toBe(
      `schema=1\nversion=${current.version}\ncli_image=ghcr.io/gpsxtreme/argus-cli@sha256:${digest("b")}\n`,
    );
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
    const priorManagementState = `schema=1\nversion=${current.version}\ncli_image=ghcr.io/gpsxtreme/argus-cli@sha256:${digest("b")}\n`;
    await writeFile(join(root, "management.state"), priorManagementState);
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
    expect(await readFile(join(root, "management.state"), "utf8")).toBe(priorManagementState);
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
