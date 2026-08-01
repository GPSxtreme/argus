import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ARGUS_FXEMBED_WORKER_NAME,
  CloudflareWorkersApiClient,
  type CloudflareWorkersClient,
  DeploymentError,
  type FxEmbedBundle,
  reconcileFxEmbed,
} from "../src/index.js";

const token = "cloudflare-token-that-must-stay-secret";
const accountId = "0123456789abcdef0123456789abcdef";
const currentHash = "a".repeat(64);
const changedHash = "b".repeat(64);

const bundle = (sha256 = currentHash): FxEmbedBundle => ({
  script: new TextEncoder().encode("export default { fetch: () => new Response('ok') };"),
  sha256,
  compatibilityDate: "2026-07-31",
});

class FixtureClient implements CloudflareWorkersClient {
  readonly puts: Array<{
    accountId: string;
    name: string;
    bundle: FxEmbedBundle;
    token: string;
  }> = [];
  readonly enabled: Array<{ accountId: string; name: string; token: string }> = [];

  constructor(
    private readonly existing:
      | { etag?: string; bundleHash?: string }
      | undefined,
  ) {}

  async getWorker(): Promise<{ etag?: string; bundleHash?: string } | undefined> {
    return this.existing;
  }

  async putWorker(input: {
    accountId: string;
    name: string;
    bundle: FxEmbedBundle;
    token: string;
  }): Promise<void> {
    this.puts.push(input);
  }

  async enableWorkersDev(
    enabledAccountId: string,
    name: string,
    enabledToken: string,
  ): Promise<string> {
    this.enabled.push({ accountId: enabledAccountId, name, token: enabledToken });
    return `https://${name}.argus-test.workers.dev`;
  }
}

const requestUrl = (input: RequestInfo | URL): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

describe("managed FxEmbed", () => {
  it("creates a missing deterministic Worker and enables workers.dev", async () => {
    const client = new FixtureClient(undefined);

    const result = await reconcileFxEmbed({
      accountId,
      workerName: ARGUS_FXEMBED_WORKER_NAME,
      token,
      bundle: bundle(),
      client,
    });

    expect(ARGUS_FXEMBED_WORKER_NAME).toBe("argus-fxembed");
    expect(client.puts).toHaveLength(1);
    expect(client.puts[0]).toMatchObject({
      accountId,
      name: "argus-fxembed",
      token,
      bundle: { sha256: currentHash, compatibilityDate: "2026-07-31" },
    });
    expect(client.enabled).toEqual([{ accountId, name: "argus-fxembed", token }]);
    expect(result).toEqual({
      changed: true,
      endpoint: "https://argus-fxembed.argus-test.workers.dev",
      bundleHash: currentHash,
    });
  });

  it("does not upload when the deployed bundle hash matches", async () => {
    const client = new FixtureClient({ etag: "etag-1", bundleHash: currentHash });

    const result = await reconcileFxEmbed({
      accountId,
      workerName: ARGUS_FXEMBED_WORKER_NAME,
      token,
      bundle: bundle(),
      client,
    });

    expect(client.puts).toHaveLength(0);
    expect(result.changed).toBe(false);
    expect(result.bundleHash).toBe(currentHash);
  });

  it("updates exactly once when the deployed bundle hash changed", async () => {
    const client = new FixtureClient({ etag: "etag-1", bundleHash: currentHash });

    const result = await reconcileFxEmbed({
      accountId,
      workerName: ARGUS_FXEMBED_WORKER_NAME,
      token,
      bundle: bundle(changedHash),
      client,
    });

    expect(client.puts).toHaveLength(1);
    expect(client.puts[0]?.bundle.sha256).toBe(changedHash);
    expect(result.changed).toBe(true);
  });

  it("rejects a non-deterministic Worker name before making API calls", async () => {
    const client = new FixtureClient(undefined);

    await expect(
      reconcileFxEmbed({
        accountId,
        workerName: "custom-fxembed",
        token,
        bundle: bundle(),
        client,
      }),
    ).rejects.toMatchObject({
      code: "FXEMBED_WORKER_NAME_INVALID",
      message: "Managed FxEmbed must use the deterministic Worker name argus-fxembed.",
    });
    expect(client.puts).toHaveLength(0);
    expect(client.enabled).toHaveLength(0);
  });

  it("reads the pinned hash from Cloudflare version annotations", async () => {
    const fixturePath = fileURLToPath(
      new URL("./fixtures/cloudflare-worker.json", import.meta.url),
    );
    const fixture = await readFile(fixturePath, "utf8");
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const client = new CloudflareWorkersApiClient({
      token,
      fetcher: async (input, init) => {
        requests.push({
          url: requestUrl(input),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return new Response(fixture, {
          status: 200,
          headers: { "content-type": "application/json", etag: '"cloudflare-etag"' },
        });
      },
    });

    await expect(client.getWorker(accountId, ARGUS_FXEMBED_WORKER_NAME)).resolves.toEqual({
      etag: '"cloudflare-etag"',
      bundleHash: currentHash,
    });
    expect(requests).toEqual([
      {
        url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/argus-fxembed/settings`,
        authorization: `Bearer ${token}`,
      },
    ]);
    expect(JSON.stringify(client)).not.toContain(token);
  });

  it("uploads a module as multipart metadata with the pinned compatibility date", async () => {
    let request: { url: string; init: RequestInit } | undefined;
    const client = new CloudflareWorkersApiClient({
      token,
      fetcher: async (input, init = {}) => {
        request = { url: requestUrl(input), init };
        return new Response(JSON.stringify({ success: true, result: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await client.putWorker({
      accountId,
      name: ARGUS_FXEMBED_WORKER_NAME,
      bundle: bundle(),
      token,
    });

    expect(request?.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/argus-fxembed`,
    );
    expect(request?.init.method).toBe("PUT");
    expect(new Headers(request?.init.headers).get("authorization")).toBe(`Bearer ${token}`);
    expect(new Headers(request?.init.headers).has("content-type")).toBe(false);
    const form = request?.init.body as FormData;
    const metadata = JSON.parse(String(form.get("metadata")));
    expect(metadata).toEqual({
      main_module: "index.js",
      compatibility_date: "2026-07-31",
      annotations: { "workers/tag": currentHash },
    });
    const script = form.get("index.js");
    expect(script).toBeInstanceOf(File);
    expect((script as File).type).toBe("application/javascript+module");
    expect(await (script as File).text()).toContain("export default");
    expect(JSON.stringify(metadata)).not.toContain(token);
  });

  it("enables workers.dev idempotently and returns the public endpoint", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const client = new CloudflareWorkersApiClient({
      token,
      fetcher: async (input, init = {}) => {
        const url = requestUrl(input);
        calls.push({
          url,
          method: init.method ?? "GET",
          ...(typeof init.body === "string" ? { body: init.body } : {}),
        });
        if (url.endsWith("/workers/subdomain")) {
          return Response.json({ success: true, result: { subdomain: "argus-test" } });
        }
        if ((init.method ?? "GET") === "GET") {
          return Response.json({
            success: true,
            result: { enabled: false, previews_enabled: false },
          });
        }
        return Response.json({
          success: true,
          result: { enabled: true, previews_enabled: false },
        });
      },
    });

    await expect(
      client.enableWorkersDev(accountId, ARGUS_FXEMBED_WORKER_NAME, token),
    ).resolves.toBe("https://argus-fxembed.argus-test.workers.dev");
    expect(calls).toEqual([
      {
        url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/argus-fxembed/subdomain`,
        method: "GET",
      },
      {
        url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/argus-fxembed/subdomain`,
        method: "POST",
        body: JSON.stringify({ enabled: true, previews_enabled: false }),
      },
      {
        url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
        method: "GET",
      },
    ]);
  });

  it("bounds HTTP requests and never exposes the token in errors or JSON", async () => {
    let signal: AbortSignal | undefined;
    const client = new CloudflareWorkersApiClient({
      token,
      requestTimeoutMs: 10,
      fetcher: async (_input, init) => {
        signal = init?.signal ?? undefined;
        return await new Promise<Response>(() => undefined);
      },
    });

    const result = client.getWorker(accountId, ARGUS_FXEMBED_WORKER_NAME);

    await expect(result).rejects.toBeInstanceOf(DeploymentError);
    await expect(result).rejects.toMatchObject({
      code: "CLOUDFLARE_REQUEST_FAILED",
      message: "Cloudflare Workers API request failed.",
    });
    await result.catch((error: unknown) => {
      expect(String(error)).not.toContain(token);
      expect(JSON.stringify(error)).not.toContain(token);
    });
    expect(signal?.aborted).toBe(true);
  }, 200);

  it("bounds reading a Cloudflare response body that never completes", async () => {
    const client = new CloudflareWorkersApiClient({
      token,
      requestTimeoutMs: 10,
      fetcher: async () =>
        new Response(
          new ReadableStream({
            start() {
              // Intentionally never enqueue or close.
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    await expect(
      Promise.race([
        client.getWorker(accountId, ARGUS_FXEMBED_WORKER_NAME),
        new Promise((resolve) => setTimeout(() => resolve("unbounded"), 100)),
      ]),
    ).rejects.toMatchObject({
      code: "CLOUDFLARE_REQUEST_FAILED",
      message: "Cloudflare Workers API request failed.",
    });
  }, 200);

  it("redacts the token when Cloudflare returns an HTTP error containing it", async () => {
    const client = new CloudflareWorkersApiClient({
      token,
      fetcher: async () =>
        Response.json(
          { success: false, errors: [{ code: 10000, message: `bad ${token}` }] },
          { status: 403 },
        ),
    });

    const result = client.putWorker({
      accountId,
      name: ARGUS_FXEMBED_WORKER_NAME,
      bundle: bundle(),
      token,
    });

    await expect(result).rejects.toMatchObject({
      code: "CLOUDFLARE_HTTP_ERROR",
      message: "Cloudflare Workers API request was rejected.",
    });
    await result.catch((error: unknown) => {
      expect(String(error)).not.toContain(token);
      expect(JSON.stringify(error)).not.toContain(token);
    });
  });
});
