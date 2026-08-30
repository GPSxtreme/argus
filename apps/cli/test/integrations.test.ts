import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@argus/app";
import { validateConfig } from "@argus/config";
import {
  applyUpdate,
  type CommandExecutor,
  DeploymentError,
  loadDeploymentState,
  type OnboardingAnswers,
  planUpdate,
  saveDeploymentState,
} from "@argus/deployment";
import {
  buildReleaseArtifacts,
  parseManagementState,
  renderArgusWrapper,
  type VerifiedReleaseManifest,
  verifyReleaseManifestWithIdentity,
  writeManagementStateAtomic,
} from "@argus/release";
import { createSqliteRepository } from "@argus/storage-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInstalledConfigIntegration,
  createProductionOnboardingIntegration,
  createProductionUpdateIntegration,
  createReleaseComposition,
} from "../src/integrations.js";
import { createNodeCliDependencies, createProgram } from "../src/program.js";

const updateEventCapture = vi.hoisted(() => ({
  events: undefined as string[] | undefined,
}));

vi.mock("@argus/deployment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argus/deployment")>();
  return {
    ...actual,
    applyUpdate: async (input: Parameters<typeof actual.applyUpdate>[0]) => {
      if (!input.plan.noop) updateEventCapture.events?.push("backup");
      const result = await actual.applyUpdate(input);
      if (!input.plan.noop) updateEventCapture.events?.push("save-deployment-state");
      return result;
    },
    finalizeUpdate: async (input: Parameters<typeof actual.finalizeUpdate>[0]) => {
      updateEventCapture.events?.push("verified");
      return actual.finalizeUpdate(input);
    },
  };
});

const repositories: Awaited<ReturnType<typeof createSqliteRepository>>[] = [];
afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
});

const config = validateConfig({
  version: 2,
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
const answers: OnboardingAnswers = {
  version: 2,
  deployment: {
    provider: "vps-docker",
    root: "/opt/argus",
    storage: "sqlite",
    apiHost: "0.0.0.0",
    apiPort: 8788,
  },
  managed: { searxng: "managed", fxembed: "disabled" },
  xReplies: {
    enabled: false,
    maxPerPost: 50,
    maxTrackingHours: 168,
    orderBy: "likes",
  },
  watches: [],
  intelligence: { enabled: false, model: "openai/gpt-4.1-mini" },
};

class DeploymentExecutor implements CommandExecutor {
  running = false;
  restarts = 0;
  async run(
    _command: string,
    args: string[],
    _options?: Parameters<CommandExecutor["run"]>[2],
  ) {
    if (args.join(" ").includes("compose -p argus ps -q --all argus")) {
      return { exitCode: 0, stdout: `${digest("9")}\n`, stderr: "" };
    }
    if (args[0] === "inspect") {
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            Type: "volume",
            Name: "argus_argus-data",
            Destination: "/app/data",
          },
        ]),
        stderr: "",
      };
    }
    if (args[0] === "volume") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          "com.docker.compose.project": "argus",
          "com.docker.compose.volume": "argus-data",
        }),
        stderr: "",
      };
    }
    if (args.includes("stop")) this.running = false;
    if (args[0] === "run" && args.includes("--network")) {
      const mount = args.find((value) => value.startsWith("type=bind,src="));
      const backupRoot = mount
        ?.slice("type=bind,src=".length)
        .split(",dst=")[0];
      if (!mount || !backupRoot) throw new Error("Missing SQLite backup mount");
      const path = join(backupRoot, "argus.db");
      if (!mount.includes("readonly")) {
        await writeFile(path, Buffer.from("CLI integration SQLite snapshot"), {
          flag: "wx",
        });
      }
      const bytes = await readFile(path);
      const receipt = {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength,
        quickCheck: "ok",
        counts: { records: 1, revisions: 2, jobs: 3 },
      };
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          args.some((value) => value.includes("type=volume")) &&
            mount.includes("readonly")
            ? { restored: true, ...receipt }
            : receipt,
        ),
        stderr: "",
      };
    }
    if (args.includes("up")) {
      this.running = true;
      this.restarts += 1;
    }
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
  cliMarker = "b",
  fxembedMarker = "default",
  releaseBaseUrl = `https://release.example/v${version}`,
}: {
  version?: string;
  appMarker?: string;
  cliMarker?: string;
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
      { name: "cli", reference: `ghcr.io/gpsxtreme/argus-cli@sha256:${digest(cliMarker)}` },
      { name: "searxng", reference: `docker.io/searxng/searxng@sha256:${digest("c")}` },
      { name: "postgres", reference: `docker.io/library/postgres@sha256:${digest("d")}` },
      { name: "fxembed", reference: `ghcr.io/gpsxtreme/argus-fxembed@sha256:${digest("e")}` },
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
      fxembed: false,
      images: {
        argus: images.app.reference,
        postgres: images.postgres.reference,
        searxng: images.searxng.reference,
        fxembed: images.fxembed.reference,
      },
    },
    updatedAt: "2026-08-01T00:00:00.000Z",
  });
};

const releaseContextFor = (fixture: ReturnType<typeof releaseFixture>): string =>
  JSON.stringify({
    schemaVersion: 1,
    manifest: Buffer.from(fixture.manifestBytes).toString("base64"),
    signature: Buffer.from(fixture.signature).toString("base64"),
    fxembed: Buffer.from(fixture.fxembed).toString("base64"),
  });

const preparePendingRecovery = async (
  root: string,
  current: ReturnType<typeof releaseFixture>,
  target: ReturnType<typeof releaseFixture>,
) => {
  const currentContext = releaseContextFor(current);
  const targetContext = releaseContextFor(target);
  const currentRelease = verifyReleaseManifestWithIdentity(
    current.manifestBytes,
    current.signature,
    current.publicKeyPem,
  );
  const targetRelease = verifyReleaseManifestWithIdentity(
    target.manifestBytes,
    target.signature,
    current.publicKeyPem,
  );
  await writeFile(join(root, "release-context.json"), currentContext);
  await saveManagedState(root, current);
  const plan = await planUpdate({
    root,
    release: targetRelease,
    rollbackRelease: currentRelease,
    executor: new DeploymentExecutor(),
  });
  await applyUpdate({
    root,
    plan,
    executor: new DeploymentExecutor(),
    getRollbackContext: async () => Buffer.from(currentContext),
  });
  await writeFile(join(root, "release-context.pending.json"), targetContext);
  return {
    currentContext,
    targetContext,
    updateState: await readFile(join(root, "update-state.json"), "utf8"),
  };
};

describe("production CLI dependencies", () => {
  it("uses the running state when Compose reports an empty health value", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-status-empty-health-"));
    const release = releaseFixture();
    await saveManagedState(root, release);
    const dependencies = createNodeCliDependencies({
      root,
      executor: {
        async run() {
          return {
            exitCode: 0,
            stdout:
              '[{"Service":"argus","State":"running","Health":"healthy"},{"Service":"searxng","State":"running","Health":""}]',
            stderr: "",
          };
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
      version: "test",
    });

    await expect(dependencies.deployment.status()).resolves.toEqual({
      state: "running",
      services: { argus: "healthy", searxng: "running" },
    });
  });
});

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

  it("plans VPS-hosted FxEmbed without touching Cloudflare", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-vps-fxembed-"));
    const fixture = releaseFixture();
    const cloudflareClientFactory = vi.fn();
    const integration = createProductionOnboardingIntegration({
      root,
      executor: new DeploymentExecutor(),
      manifestUrl: "https://release.example/manifest.json",
      publicKeyPem: fixture.publicKeyPem,
      cloudflareClientFactory,
      fetcher: async (input) => {
        const url = String(input);
        const bytes = url.endsWith("manifest.sig")
          ? fixture.signature
          : url.endsWith("fxembed.js")
            ? fixture.fxembed
            : fixture.manifestBytes;
        return new Response(Uint8Array.from(bytes).buffer);
      },
    });

    const inspection = await integration.inspect({
      answers: {
        ...answers,
        managed: { searxng: "disabled", fxembed: "vps" },
      },
      secrets: { ARGUS_API_TOKEN: "fixture-token" },
    });

    expect(inspection.plan).toMatchObject({
      endpoints: { fxembed: "http://fxembed:8787" },
      fxembed: { mode: "vps" },
      desired: {
        fxembed: true,
        images: {
          fxembed: {
            reference: `ghcr.io/gpsxtreme/argus-fxembed@sha256:${digest("e")}`,
          },
        },
      },
    });
    expect(cloudflareClientFactory).not.toHaveBeenCalled();
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
        inspectCurrentRelease: expect.any(Function),
        validateCurrentReleaseInspection: expect.any(Function),
        fetchRollbackSnapshot: expect.any(Function),
        validateRollbackSnapshot: expect.any(Function),
        getRollbackContext: expect.any(Function),
        stageCurrentRelease: expect.any(Function),
        promoteCurrentRelease: expect.any(Function),
        reconcileCurrentRelease: expect.any(Function),
        promoteRollbackSnapshot: expect.any(Function),
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

  it("returns the exact verified prior context bytes before promoting a target release", async () => {
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

    const verifiedA = (await integration.inspectCurrentRelease()).release;
    const verifiedB = await integration.fetchUpdateRelease();
    const rollbackContext = await integration.getRollbackContext(verifiedA);
    await integration.stageCurrentRelease(verifiedB);
    await integration.promoteCurrentRelease(verifiedB);
    expect(Buffer.from(rollbackContext).toString("utf8")).toContain(
      Buffer.from(releaseA.manifestBytes).toString("base64"),
    );
    target = releaseC;
    await expect(integration.fetchUpdateRelease()).resolves.toMatchObject({ manifest: { version: "3.0.0" } });
  });

  it("fails closed on interrupted context promotion without authoritative rollback state", async () => {
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

    await expect(integration.inspectCurrentRelease()).rejects.toMatchObject({ code: "UPDATE_ROLLBACK_UNAVAILABLE" });
    expect(await readFile(join(root, "release-context.json"), "utf8")).toBe(contextFor(releaseA));
  });

  it("keeps pending recovery, current context, and transaction bytes unchanged during a dry-run inspection", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-update-read-only-inspection-"));
    const current = releaseFixture({ version: "1.0.0", appMarker: "a" });
    const target = releaseFixture({ version: "2.0.0", appMarker: "b" });
    const { currentContext, targetContext, updateState } = await preparePendingRecovery(root, current, target);
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
            : target.fxembed;
        return new Response(Uint8Array.from(bytes).buffer);
      },
    });
    const dependencies = createNodeCliDependencies({
      root,
      executor: new DeploymentExecutor(),
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

    await expect(dependencies.deployment.inspectUpdate?.()).resolves.toMatchObject({
      noop: true,
      rollbackRelease: { manifest: { version: target.version } },
      currentReleaseInspection: {
        recovery: "promote-pending",
        release: { manifest: { version: target.version } },
      },
    });
    await createProgram(dependencies).parseAsync(["node", "argus", "update", "--dry-run"]);

    expect(await readFile(join(root, "release-context.json"), "utf8")).toBe(currentContext);
    expect(await readFile(join(root, "release-context.pending.json"), "utf8")).toBe(targetContext);
    expect(await readFile(join(root, "update-state.json"), "utf8")).toBe(updateState);
  });

  it("leaves every durable recovery file unchanged when a confirmed no-op retry is unhealthy", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-update-unhealthy-recovery-"));
    const current = releaseFixture({ version: "1.0.0", appMarker: "a" });
    const target = releaseFixture({ version: "2.0.0", appMarker: "b" });
    const { currentContext, targetContext, updateState } = await preparePendingRecovery(root, current, target);
    const managementState = `schema=1\nversion=${current.version}\ncli_image=ghcr.io/gpsxtreme/argus-cli@sha256:${digest("b")}\n`;
    await writeFile(join(root, "management.state"), managementState);
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
            : target.fxembed;
        return new Response(Uint8Array.from(bytes).buffer);
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

    await expect(
      createProgram(dependencies).parseAsync(["node", "argus", "update", "--yes"]),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(await readFile(join(root, "release-context.json"), "utf8")).toBe(currentContext);
    expect(await readFile(join(root, "release-context.pending.json"), "utf8")).toBe(targetContext);
    expect(await readFile(join(root, "management.state"), "utf8")).toBe(managementState);
    expect(await readFile(join(root, "update-state.json"), "utf8")).toBe(updateState);
  });

  it("reconciles a healthy pending recovery only after health, management promotion, and final verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-update-healthy-recovery-"));
    const current = releaseFixture({ version: "1.0.0", appMarker: "a" });
    const target = releaseFixture({ version: "2.0.0", appMarker: "b" });
    const { targetContext } = await preparePendingRecovery(root, current, target);
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
            : target.fxembed;
        return new Response(Uint8Array.from(bytes).buffer);
      },
    });
    const events: string[] = [];
    const updateIntegration = {
      ...signed,
      async reconcileCurrentRelease(
        inspection: Parameters<typeof signed.reconcileCurrentRelease>[0],
      ) {
        events.push("context");
        await signed.reconcileCurrentRelease(inspection);
      },
      async promoteManagementRelease(
        release: Parameters<typeof signed.promoteManagementRelease>[0],
      ) {
        events.push("management");
        await signed.promoteManagementRelease(release);
      },
    };
    const dependencies = createNodeCliDependencies({
      root,
      executor: {
        async run(_command, args) {
          if (args.includes("ps")) {
            events.push("health");
            return {
              exitCode: 0,
              stdout: '[{"Service":"argus","State":"running","Health":"healthy"}]',
              stderr: "",
            };
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
      updateIntegration,
      version: "test",
    });

    updateEventCapture.events = events;
    try {
      await createProgram(dependencies).parseAsync(["node", "argus", "update", "--yes"]);
    } finally {
      updateEventCapture.events = undefined;
    }

    expect(events).toEqual(["health", "context", "management", "verified"]);
    expect(await readFile(join(root, "release-context.json"), "utf8")).toBe(targetContext);
    await expect(readFile(join(root, "release-context.pending.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(root, "update-state.json"), "utf8")).resolves.toContain(
      '"phase": "verified"',
    );
  });

  it("settles a pending recovery before staging a newer target so rollback holds the recovered context", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-update-recovery-then-target-"));
    const current = releaseFixture({ version: "1.0.0", appMarker: "a" });
    const recovered = releaseFixture({ version: "2.0.0", appMarker: "b", cliMarker: "c" });
    const target = releaseFixture({ version: "3.0.0", appMarker: "d", cliMarker: "e" });
    const { targetContext: recoveredContext } = await preparePendingRecovery(root, current, recovered);
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
            : target.fxembed;
        return new Response(Uint8Array.from(bytes).buffer);
      },
    });
    const recoveryExecutor = new DeploymentExecutor();
    recoveryExecutor.running = true;
    const dependencies = createNodeCliDependencies({
      root,
      executor: recoveryExecutor,
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

    await createProgram(dependencies).parseAsync(["node", "argus", "update", "--yes"]);

    const persisted = JSON.parse(await readFile(join(root, "update-state.json"), "utf8")) as {
      phase: string;
      release: { manifest: { version: string } };
      backup: { signedContext: { relativePath: string } };
    };
    expect(persisted).toMatchObject({
      phase: "verified",
      release: { manifest: { version: target.version } },
    });
    expect(await readFile(join(root, persisted.backup.signedContext.relativePath), "utf8")).toBe(
      recoveredContext,
    );
    expect(parseManagementState(await readFile(join(root, "management.state"), "utf8"))).toMatchObject({
      version: target.version,
      cliImage: `ghcr.io/gpsxtreme/argus-cli@sha256:${digest("e")}`,
    });
  });

  it("holds verified rollback bytes across confirmation and rejects mutated inspection material before side effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-update-rollback-lifecycle-"));
    const launcherDirectory = await mkdtemp(join(tmpdir(), "argus-immutable-launcher-"));
    const launcher = join(launcherDirectory, "argus");
    const current = releaseFixture({ version: "1.0.0", appMarker: "a", cliMarker: "b" });
    const target = releaseFixture({ version: "2.0.0", appMarker: "e", cliMarker: "f" });
    const currentContext = JSON.stringify({
      schemaVersion: 1,
      manifest: Buffer.from(current.manifestBytes).toString("base64"),
      signature: Buffer.from(current.signature).toString("base64"),
      fxembed: Buffer.from(current.fxembed).toString("base64"),
    });
    const launcherBytes = Buffer.from(renderArgusWrapper());
    await writeFile(launcher, launcherBytes, { mode: 0o755 });
    await writeFile(join(root, "release-context.json"), currentContext);
    await writeFile(
      join(root, "management.state"),
      `schema=1\nversion=${current.version}\ncli_image=ghcr.io/gpsxtreme/argus-cli@sha256:${digest("b")}\n`,
    );
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
            : target.fxembed;
        return new Response(Uint8Array.from(bytes).buffer);
      },
    });
    const deploymentExecutor = new DeploymentExecutor();
    const dependencies = createNodeCliDependencies({
      root,
      executor: deploymentExecutor,
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

    await createProgram(dependencies).parseAsync(["node", "argus", "update", "--yes"]);
    await createProgram(dependencies).parseAsync(["node", "argus", "update", "--yes"]);
    const targetContext = await readFile(join(root, "release-context.json"), "utf8");
    const targetManagementState = await readFile(join(root, "management.state"), "utf8");
    await expect(readFile(join(root, "rollback-release-context.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const persistedManifestInspection = await dependencies.deployment.inspectRollbackUpdate?.();
    const originalUpdateState = await readFile(join(root, "update-state.json"), "utf8");
    const forgedUpdateState = JSON.parse(originalUpdateState) as {
      rollbackRelease: VerifiedReleaseManifest;
    };
    forgedUpdateState.rollbackRelease.manifest.publishedAt = "2026-08-02T00:00:00.000Z";
    forgedUpdateState.rollbackRelease.manifest.images = {
      app: {
        reference: `ghcr.io/gpsxtreme/argus@sha256:${digest("1")}`,
        digest: `sha256:${digest("1")}`,
      },
      cli: {
        reference: `ghcr.io/gpsxtreme/argus-cli@sha256:${digest("2")}`,
        digest: `sha256:${digest("2")}`,
      },
      postgres: {
        reference: `docker.io/library/postgres@sha256:${digest("3")}`,
        digest: `sha256:${digest("3")}`,
      },
      searxng: {
        reference: `docker.io/searxng/searxng@sha256:${digest("4")}`,
        digest: `sha256:${digest("4")}`,
      },
      fxembed: {
        reference: `ghcr.io/gpsxtreme/argus-fxembed@sha256:${digest("5")}`,
        digest: `sha256:${digest("5")}`,
      },
    };
    forgedUpdateState.rollbackRelease.manifest.assets.fxembed = {
      url: "https://attacker.test/fxembed.js",
      sha256: digest("5"),
      compatibilityDate: "2026-08-02",
    };
    forgedUpdateState.rollbackRelease.manifest.assets.wrapper = {
      url: "https://attacker.test/argus",
      sha256: digest("6"),
    };
    await writeFile(join(root, "update-state.json"), JSON.stringify(forgedUpdateState));
    await expect(
      dependencies.deployment.applyRollbackUpdate?.(persistedManifestInspection),
    ).rejects.toMatchObject({ code: "UPDATE_ROLLBACK_INCOMPATIBLE" });
    expect(await loadDeploymentState(root)).toMatchObject({ argusVersion: target.version });
    expect(await readFile(join(root, "release-context.json"), "utf8")).toBe(targetContext);
    expect(await readFile(join(root, "management.state"), "utf8")).toBe(targetManagementState);
    expect(deploymentExecutor.restarts).toBe(1);
    await writeFile(join(root, "update-state.json"), originalUpdateState);

    const mutatedReleaseInspection = await dependencies.deployment.inspectRollbackUpdate?.() as {
      snapshot: { release: { manifest: { version: string } } };
    };
    mutatedReleaseInspection.snapshot.release.manifest.version = "forged";
    await expect(
      dependencies.deployment.applyRollbackUpdate?.(mutatedReleaseInspection),
    ).rejects.toMatchObject({ code: "UPDATE_ROLLBACK_UNAVAILABLE" });
    expect(await loadDeploymentState(root)).toMatchObject({ argusVersion: target.version });
    expect(await readFile(join(root, "release-context.json"), "utf8")).toBe(targetContext);
    expect(await readFile(join(root, "management.state"), "utf8")).toBe(targetManagementState);
    expect(deploymentExecutor.restarts).toBe(1);

    const invalidInspection = await dependencies.deployment.inspectRollbackUpdate?.() as {
      snapshot: { signedContext: Uint8Array };
    };
    invalidInspection.snapshot.signedContext[0] =
      (invalidInspection.snapshot.signedContext[0] ?? 0) ^ 0xff;
    await expect(
      dependencies.deployment.applyRollbackUpdate?.(invalidInspection),
    ).rejects.toMatchObject({ code: "UPDATE_ROLLBACK_UNAVAILABLE" });
    expect(await loadDeploymentState(root)).toMatchObject({ argusVersion: target.version });
    expect(await readFile(join(root, "release-context.json"), "utf8")).toBe(targetContext);
    expect(await readFile(join(root, "management.state"), "utf8")).toBe(targetManagementState);
    expect(deploymentExecutor.restarts).toBe(1);

    const heldInspection = await dependencies.deployment.inspectRollbackUpdate?.();
    const persistedUpdate = JSON.parse(
      await readFile(join(root, "update-state.json"), "utf8"),
    ) as { backup: { signedContext: { relativePath: string } } };
    await unlink(join(root, persistedUpdate.backup.signedContext.relativePath));
    await expect(
      dependencies.deployment.applyRollbackUpdate?.(heldInspection),
    ).resolves.toMatchObject({ phase: "rolled_back" });

    expect(await loadDeploymentState(root)).toMatchObject({
      argusVersion: current.version,
      compose: { images: { argus: `ghcr.io/gpsxtreme/argus@sha256:${digest("a")}` } },
      services: { argus: { image: `ghcr.io/gpsxtreme/argus@sha256:${digest("a")}` } },
    });
    expect(await readFile(join(root, "release-context.json"), "utf8")).toBe(currentContext);
    expect(parseManagementState(await readFile(join(root, "management.state"), "utf8"))).toEqual({
      schema: 1,
      version: current.version,
      cliImage: `ghcr.io/gpsxtreme/argus-cli@sha256:${digest("b")}`,
    });
    expect(deploymentExecutor.restarts).toBe(2);
    expect(await readFile(launcher)).toStrictEqual(launcherBytes);
  });

  it("keeps the prior rollback slot when a later update fails before durable update state is written", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-update-rollback-pre-persist-failure-"));
    const releaseA = releaseFixture({ version: "1.0.0", appMarker: "a", cliMarker: "b" });
    const releaseB = releaseFixture({ version: "2.0.0", appMarker: "e", cliMarker: "f" });
    const releaseC = releaseFixture({ version: "3.0.0", appMarker: "c", cliMarker: "d" });
    const releaseAContext = JSON.stringify({
      schemaVersion: 1,
      manifest: Buffer.from(releaseA.manifestBytes).toString("base64"),
      signature: Buffer.from(releaseA.signature).toString("base64"),
      fxembed: Buffer.from(releaseA.fxembed).toString("base64"),
    });
    await writeFile(join(root, "release-context.json"), releaseAContext);
    await writeFile(
      join(root, "management.state"),
      `schema=1\nversion=${releaseA.version}\ncli_image=ghcr.io/gpsxtreme/argus-cli@sha256:${digest("b")}\n`,
    );
    await saveManagedState(root, releaseA);

    let target = releaseB;
    let failBeforePersist = false;
    const signed = createProductionUpdateIntegration({
      root,
      manifestUrl: "https://release.example/manifest.json",
      publicKeyPem: releaseA.publicKeyPem,
      fetcher: async (input) => {
        const url = String(input);
        const bytes = url.endsWith("manifest.sig")
          ? target.signature
          : url.endsWith("manifest.json")
            ? target.manifestBytes
            : target.fxembed;
        return new Response(Uint8Array.from(bytes).buffer);
      },
    });
    const updateIntegration = {
      ...signed,
      async stageCurrentRelease(release: Awaited<ReturnType<typeof signed.fetchUpdateRelease>>) {
        if (failBeforePersist) {
          throw new DeploymentError(
            "UPDATE_STAGING_FAILED",
            "Injected failure before deployment update state persistence.",
          );
        }
        await signed.stageCurrentRelease(release);
      },
    };
    const dependencies = createNodeCliDependencies({
      root,
      executor: new DeploymentExecutor(),
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

    await createProgram(dependencies).parseAsync(["node", "argus", "update", "--yes"]);
    const durableUpdateState = await readFile(join(root, "update-state.json"), "utf8");
    target = releaseC;
    failBeforePersist = true;

    await expect(
      createProgram(dependencies).parseAsync(["node", "argus", "update", "--yes"]),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(await readFile(join(root, "update-state.json"), "utf8")).toBe(durableUpdateState);
    await expect(signed.fetchRollbackSnapshot()).resolves.toMatchObject({
      release: { manifest: { version: releaseA.version } },
    });
  });

  it("retains the verified rollback context and target selections when CLI rollback health fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-update-rollback-health-failure-"));
    const current = releaseFixture({ version: "1.0.0", appMarker: "a", cliMarker: "b" });
    const target = releaseFixture({ version: "2.0.0", appMarker: "e", cliMarker: "f" });
    const currentContext = JSON.stringify({
      schemaVersion: 1,
      manifest: Buffer.from(current.manifestBytes).toString("base64"),
      signature: Buffer.from(current.signature).toString("base64"),
      fxembed: Buffer.from(current.fxembed).toString("base64"),
    });
    const targetContext = JSON.stringify({
      schemaVersion: 1,
      manifest: Buffer.from(target.manifestBytes).toString("base64"),
      signature: Buffer.from(target.signature).toString("base64"),
      fxembed: Buffer.from(target.fxembed).toString("base64"),
    });
    await writeFile(join(root, "release-context.json"), currentContext);
    await writeFile(
      join(root, "management.state"),
      `schema=1\nversion=${current.version}\ncli_image=ghcr.io/gpsxtreme/argus-cli@sha256:${digest("b")}\n`,
    );
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
            : target.fxembed;
        return new Response(Uint8Array.from(bytes).buffer);
      },
    });
    let restarts = 0;
    const deploymentExecutor = new DeploymentExecutor();
    const dependencies = createNodeCliDependencies({
      root,
      executor: {
        async run(command, args, options) {
          if (args.includes("up")) restarts += 1;
          if (args.at(-1) === "json") {
            return {
              exitCode: 0,
              stdout:
                restarts === 1
                  ? '[{"Service":"argus","State":"running","Health":"healthy"}]'
                  : "[]",
              stderr: "",
            };
          }
          return deploymentExecutor.run(command, args, options);
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

    await createProgram(dependencies).parseAsync(["node", "argus", "update", "--yes"]);
    await expect(
      createProgram(dependencies).parseAsync([
        "node",
        "argus",
        "update",
        "--rollback",
        "--yes",
      ]),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(await loadDeploymentState(root)).toMatchObject({ argusVersion: target.version });
    expect(await readFile(join(root, "release-context.json"), "utf8")).toBe(targetContext);
    expect(parseManagementState(await readFile(join(root, "management.state"), "utf8"))).toEqual({
      schema: 1,
      version: target.version,
      cliImage: `ghcr.io/gpsxtreme/argus-cli@sha256:${digest("f")}`,
    });
    await expect(updateIntegration.fetchRollbackSnapshot()).resolves.toMatchObject({
      release: { manifest: { version: current.version } },
    });
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
    const currentReleaseInspection = await signed.inspectCurrentRelease();
    const rollbackSnapshot = {} as Awaited<ReturnType<typeof signed.fetchRollbackSnapshot>>;
    const events: string[] = [];
    const deploymentExecutor = new DeploymentExecutor();
    const dependencies = createNodeCliDependencies({
      root,
      executor: {
        async run(command, args, options) {
          if (args.includes("pull")) events.push("pull");
          if (args.includes("migrate")) events.push("migrate");
          if (args.includes("up")) events.push("reconcile");
          if (args.at(-1) === "json") {
            events.push("health");
            return { exitCode: 0, stdout: '[{"Service":"argus","State":"running","Health":"healthy"}]', stderr: "" };
          }
          return deploymentExecutor.run(command, args, options);
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
        async inspectCurrentRelease() { return currentReleaseInspection; },
        validateCurrentReleaseInspection() { return currentReleaseInspection; },
        async fetchRollbackSnapshot() { return rollbackSnapshot; },
        validateRollbackSnapshot() { return rollbackSnapshot; },
        async getRollbackContext() {
          events.push("get-rollback-context");
          return Buffer.from(context);
        },
        async stageCurrentRelease() { events.push("stage-release-context"); },
        async promoteCurrentRelease() { events.push("promote-release-context"); },
        async reconcileCurrentRelease() { events.push("reconcile-current-context"); },
        async promoteRollbackSnapshot() { events.push("promote-rollback-context"); },
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
      "get-rollback-context",
      "pull",
      "migrate",
      "reconcile",
      "health",
      "save-deployment-state",
      "promote-release-context",
      "promote-management-state",
      "verified",
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
    const priorManagementState = await readFile(join(root, "management.state"), "utf8");
    const swappedCliRelease = structuredClone(release);
    swappedCliRelease.manifest.images.cli = {
      reference: `ghcr.io/gpsxtreme/argus-cli@sha256:${digest("e")}`,
      digest: `sha256:${digest("e")}`,
    };
    await expect(
      integration.promoteManagementRelease(swappedCliRelease),
    ).rejects.toMatchObject({ code: "UPDATE_RELEASE_UNVERIFIED" });
    expect(await readFile(join(root, "management.state"), "utf8")).toBe(
      priorManagementState,
    );
  });

  it("preserves management state and skips final verification when signed-context promotion fails after promotion", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-update-before-management-"));
    const current = releaseFixture({ version: "1.0.0", appMarker: "a" });
    const target = releaseFixture({ version: "2.0.0", appMarker: "b" });
    const currentContext = JSON.stringify({
      schemaVersion: 1,
      manifest: Buffer.from(current.manifestBytes).toString("base64"),
      signature: Buffer.from(current.signature).toString("base64"),
      fxembed: Buffer.from(current.fxembed).toString("base64"),
    });
    const targetContext = JSON.stringify({
      schemaVersion: 1,
      manifest: Buffer.from(target.manifestBytes).toString("base64"),
      signature: Buffer.from(target.signature).toString("base64"),
      fxembed: Buffer.from(target.fxembed).toString("base64"),
    });
    const priorManagementState = `schema=1\nversion=${current.version}\ncli_image=ghcr.io/gpsxtreme/argus-cli@sha256:${digest("b")}\n`;
    await writeFile(join(root, "release-context.json"), currentContext);
    await writeFile(join(root, "management.state"), priorManagementState);
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
            : target.fxembed;
        return new Response(Uint8Array.from(bytes).buffer);
      },
    });
    let managementPromotionCalled = false;
    const updateIntegration = {
      fetchUpdateRelease: () => signed.fetchUpdateRelease(),
      inspectCurrentRelease: () => signed.inspectCurrentRelease(),
      validateCurrentReleaseInspection: (
        inspection: unknown,
        expectedRelease: VerifiedReleaseManifest,
      ) => signed.validateCurrentReleaseInspection(inspection, expectedRelease),
      fetchRollbackSnapshot: () => signed.fetchRollbackSnapshot(),
      validateRollbackSnapshot: (snapshot: unknown) => signed.validateRollbackSnapshot(snapshot),
      getRollbackContext: (release: VerifiedReleaseManifest) => signed.getRollbackContext(release),
      stageCurrentRelease: (release: Awaited<ReturnType<typeof signed.fetchUpdateRelease>>) => signed.stageCurrentRelease(release),
      async promoteCurrentRelease(release: Awaited<ReturnType<typeof signed.fetchUpdateRelease>>) {
        await signed.promoteCurrentRelease(release);
        throw new DeploymentError(
          "UPDATE_SIGNED_CONTEXT_PROMOTION_FAILED",
          "Signed release context promotion failed after completion.",
        );
      },
      reconcileCurrentRelease: (inspection: Parameters<typeof signed.reconcileCurrentRelease>[0]) =>
        signed.reconcileCurrentRelease(inspection),
      async promoteRollbackSnapshot(
        snapshot: Parameters<typeof signed.promoteRollbackSnapshot>[0],
      ) {
        await signed.promoteRollbackSnapshot(snapshot);
      },
      async promoteManagementRelease(release: Awaited<ReturnType<typeof signed.fetchUpdateRelease>>) {
        managementPromotionCalled = true;
        await signed.promoteManagementRelease(release);
      },
    };
    let verified = false;
    let stdout = "";
    const dependencies = createNodeCliDependencies({
      root,
      executor: new DeploymentExecutor(),
      prompt: {
        async confirm() { return true; },
        async select() { return ""; },
        async multiselect() { return []; },
        async text() { return ""; },
        async secret() { return ""; },
      },
      io: { stdout(value) { stdout += value; }, stderr() {} },
      updateIntegration,
      version: "test",
    });
    const verifyUpdate = dependencies.deployment.verifyUpdate;
    dependencies.deployment.verifyUpdate = async (applied) => {
      verified = true;
      return verifyUpdate?.(applied);
    };

    await expect(
      createProgram(dependencies).parseAsync(["node", "argus", "update", "--json", "--yes"]),
    ).rejects.toMatchObject({ exitCode: 1 });
    expect(managementPromotionCalled).toBe(false);
    expect(verified).toBe(false);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false });
    expect(JSON.parse(stdout)).not.toHaveProperty("data");
    expect(await readFile(join(root, "release-context.json"), "utf8")).toBe(targetContext);
    expect(await readFile(join(root, "management.state"), "utf8")).toBe(priorManagementState);
    await expect(readFile(join(root, "update-state.json"), "utf8")).resolves.toContain(
      '"phase": "restarted"',
    );
  });

  it("retries an interrupted management promotion to one canonical advanced state", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-update-during-management-"));
    const current = releaseFixture({ version: "1.0.0", appMarker: "a" });
    const target = releaseFixture({ version: "2.0.0", appMarker: "b", cliMarker: "e" });
    const currentContext = JSON.stringify({
      schemaVersion: 1,
      manifest: Buffer.from(current.manifestBytes).toString("base64"),
      signature: Buffer.from(current.signature).toString("base64"),
      fxembed: Buffer.from(current.fxembed).toString("base64"),
    });
    const targetContext = JSON.stringify({
      schemaVersion: 1,
      manifest: Buffer.from(target.manifestBytes).toString("base64"),
      signature: Buffer.from(target.signature).toString("base64"),
      fxembed: Buffer.from(target.fxembed).toString("base64"),
    });
    const priorManagementState = `schema=1\nversion=${current.version}\ncli_image=ghcr.io/gpsxtreme/argus-cli@sha256:${digest("b")}\n`;
    await writeFile(join(root, "release-context.json"), currentContext);
    await writeFile(join(root, "management.state"), priorManagementState);
    await saveManagedState(root, current);
    let writeAttempted = false;
    let interruptRename = true;
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
            : target.fxembed;
        return new Response(Uint8Array.from(bytes).buffer);
      },
      writeManagementState: async (path, state) => {
        writeAttempted = true;
        await writeManagementStateAtomic(path, state, {
          lstat,
          open,
          async rename(source, destination) {
            if (interruptRename) {
              interruptRename = false;
              throw new DeploymentError(
                "UPDATE_MANAGEMENT_PROMOTION_FAILED",
                "Management state promotion failed.",
              );
            }
            await rename(source, destination);
          },
          unlink,
        });
      },
    });
    let verified = false;
    let stdout = "";
    const dependencies = createNodeCliDependencies({
      root,
      executor: new DeploymentExecutor(),
      prompt: {
        async confirm() { return true; },
        async select() { return ""; },
        async multiselect() { return []; },
        async text() { return ""; },
        async secret() { return ""; },
      },
      io: { stdout(value) { stdout += value; }, stderr() {} },
      updateIntegration,
      version: "test",
    });
    const verifyUpdate = dependencies.deployment.verifyUpdate;
    dependencies.deployment.verifyUpdate = async (applied) => {
      verified = true;
      return verifyUpdate?.(applied);
    };

    await expect(
      createProgram(dependencies).parseAsync(["node", "argus", "update", "--json", "--yes"]),
    ).rejects.toMatchObject({ exitCode: 1 });
    expect(writeAttempted).toBe(true);
    expect(verified).toBe(false);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false });
    expect(JSON.parse(stdout)).not.toHaveProperty("data");
    expect(await readFile(join(root, "release-context.json"), "utf8")).toBe(targetContext);
    expect(await readFile(join(root, "management.state"), "utf8")).toBe(priorManagementState);
    await expect(readFile(join(root, "update-state.json"), "utf8")).resolves.toContain(
      '"phase": "restarted"',
    );
    expect(await readdir(root)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/\.tmp$/u)]),
    );

    stdout = "";
    verified = false;
    await createProgram(dependencies).parseAsync([
      "node",
      "argus",
      "update",
      "--json",
      "--yes",
    ]);
    expect(verified).toBe(true);
    expect(JSON.parse(stdout)).toMatchObject({
      contractVersion: 1,
      ok: true,
      data: { version: target.version, health: { healthy: true } },
    });
    expect(parseManagementState(await readFile(join(root, "management.state"), "utf8"))).toEqual({
      schema: 1,
      version: target.version,
      cliImage: `ghcr.io/gpsxtreme/argus-cli@sha256:${digest("e")}`,
    });
    await expect(readFile(join(root, "update-state.json"), "utf8")).resolves.toContain(
      '"phase": "verified"',
    );
    expect(await readdir(root)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/\.tmp$/u)]),
    );
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
    const currentRelease = verifyReleaseManifestWithIdentity(
      current.manifestBytes,
      current.signature,
      current.publicKeyPem,
    );
    const staleRelease = verifyReleaseManifestWithIdentity(
      stale.manifestBytes,
      stale.signature,
      stale.publicKeyPem,
    );
    const deployed = await loadDeploymentState(root);
    if (deployed === undefined) throw new Error("expected managed deployment state");
    const priorRoot = await mkdtemp(join(tmpdir(), "argus-legacy-prior-state-"));
    await saveManagedState(priorRoot, stale);
    const priorState = await loadDeploymentState(priorRoot);
    if (priorState === undefined) throw new Error("expected prior deployment state");
    const legacyJournal = `${JSON.stringify({
      phase: "verified",
      plan: { currentVersion: stale.version, targetVersion: current.version },
      previousState: priorState,
      release: currentRelease,
      rollbackRelease: staleRelease,
      backup: {
        path: join(root, "backups", `legacy-${stale.version}`),
        state: priorState,
        sqliteFiles: [],
        signedContext: {
          relativePath: `backups/legacy-${stale.version}/release-context.json`,
          sha256: digest("9"),
        },
      },
    }, null, 2)}\n`;
    await writeFile(join(root, "update-state.json"), legacyJournal);
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
    const executorCalls: string[][] = [];
    let stdout = "";
    const dependencies = createNodeCliDependencies({
      root,
      executor: {
        async run(_command, args) {
          executorCalls.push(args);
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
      io: { stdout(value) { stdout += value; }, stderr() {} },
      updateIntegration,
      version: "test",
    });

    await createProgram(dependencies).parseAsync(["node", "argus", "update", "--json", "--yes"]);
    expect(JSON.parse(stdout)).toMatchObject({
      contractVersion: 1,
      ok: true,
      data: { version: current.version, health: { healthy: true } },
    });
    expect(executorCalls.filter((args) => !args.includes("ps"))).toEqual([]);
    expect(await readFile(join(root, "update-state.json"), "utf8")).toBe(legacyJournal);
    expect(await readFile(join(root, "release-context.json"), "utf8")).toBe(context);
    expect(await readFile(join(root, "management.state"), "utf8")).toBe(
      `schema=1\nversion=${current.version}\ncli_image=ghcr.io/gpsxtreme/argus-cli@sha256:${digest("b")}\n`,
    );

    const managementState = await readFile(join(root, "management.state"), "utf8");
    stdout = "";
    await expect(
      createProgram(dependencies).parseAsync(["node", "argus", "update", "--rollback", "--json", "--yes"]),
    ).rejects.toMatchObject({ exitCode: 1 });
    expect(JSON.parse(stdout)).toMatchObject({ error: { code: "UPDATE_ROLLBACK_UNAVAILABLE" } });
    expect(await loadDeploymentState(root)).toEqual(deployed);
    expect(await readFile(join(root, "release-context.json"), "utf8")).toBe(context);
    expect(await readFile(join(root, "management.state"), "utf8")).toBe(managementState);
    expect(await readFile(join(root, "update-state.json"), "utf8")).toBe(legacyJournal);
  });

  it("rejects an unhealthy no-op without promoting a different signed target context", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-update-noop-"));
    const current = releaseFixture({ version: "1.0.0", appMarker: "a" });
    const target = releaseFixture({
      version: "1.0.0",
      appMarker: "a",
      cliMarker: "e",
      fxembedMarker: "target",
    });
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
    await expect(readFile(join(root, "release-context.pending.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(updateIntegration.inspectCurrentRelease()).resolves.toMatchObject({
      release: {
        manifest: {
          images: { cli: { reference: `ghcr.io/gpsxtreme/argus-cli@sha256:${digest("b")}` } },
          version: current.version,
        },
      },
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
