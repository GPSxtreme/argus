import { describe, expect, it, vi } from "vitest";
import {
  createTrustedServiceOrigin,
  extractPage,
  isPublicIpAddress,
  parseFeed,
  safeHttpGet,
  searchSearxng,
  WebAdapter,
} from "../src/index.js";

describe("web source", () => {
  it("extracts readable site data", () => {
    const item = extractPage(
      "https://example.com/news",
      "<html><head><title>News</title></head><body><article><h1>Launch</h1><p>Argus data layer is available today.</p></article></body></html>",
    );
    expect(item).toMatchObject({
      externalId: "https://example.com/news",
      title: "Launch",
    });
    expect(item.text).toContain("Argus data layer");
  });

  it("parses RSS items", () => {
    const items = parseFeed(
      "https://example.com/rss",
      `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>
       <item><guid>post-1</guid><title>Release</title><link>https://example.com/1</link>
       <description>Argus V1</description><pubDate>Fri, 31 Jul 2026 00:00:00 GMT</pubDate></item>
       </channel></rss>`,
    );
    expect(items[0]).toMatchObject({
      externalId: "post-1",
      title: "Release",
      text: "Argus V1",
    });
  });

  it("discovers URLs through SearXNG", async () => {
    const request = vi.fn().mockResolvedValue(
      Response.json({
        results: [
          { url: "https://example.com/a", title: "A", content: "Result A" },
        ],
      }),
    );
    const origin = createTrustedServiceOrigin("http://searxng:8080");
    expect(
      await searchSearxng(origin, "argus", { request }),
    ).toEqual([
      expect.objectContaining({
        externalId: "https://example.com/a",
        text: "Result A",
      }),
    ]);
    expect(String(request.mock.calls[0]?.[0])).toBe(
      "http://searxng:8080/search?q=argus&format=json",
    );
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      redirect: "manual",
    });
  });

  it("scopes trusted search transport to an exact configured origin", async () => {
    for (const endpoint of [
      "http://user:pass@searxng:8080",
      "http://searxng:8080/search",
      "http://searxng:8080/?next=http://attacker",
      "file:///tmp/search",
    ]) {
      expect(() => createTrustedServiceOrigin(endpoint)).toThrowError(
        expect.objectContaining({ code: "TRUSTED_SERVICE_ORIGIN_INVALID" }),
      );
    }

    const origin = createTrustedServiceOrigin("http://searxng:8080");
    await expect(
      searchSearxng(
        {} as ReturnType<typeof createTrustedServiceOrigin>,
        "argus",
        { request: vi.fn() },
      ),
    ).rejects.toMatchObject({ code: "TRUSTED_SERVICE_ORIGIN_INVALID" });
    await expect(
      searchSearxng(origin, "argus", {
        request: async () =>
          new Response(null, {
            status: 302,
            headers: { location: "http://attacker.example/search" },
          }),
      }),
    ).rejects.toMatchObject({ code: "TRUSTED_SERVICE_REDIRECT" });
  });

  it("bounds trusted search time and response size", async () => {
    const origin = createTrustedServiceOrigin("https://search.example");
    await expect(
      searchSearxng(origin, "argus", {
        timeoutMs: 5,
        request: async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
      }),
    ).rejects.toMatchObject({ code: "TRUSTED_SERVICE_REQUEST_FAILED" });
    await expect(
      searchSearxng(origin, "argus", {
        maxBodyBytes: 16,
        request: async () => new Response("x".repeat(17)),
      }),
    ).rejects.toMatchObject({ code: "TRUSTED_SERVICE_RESPONSE_TOO_LARGE" });
  });

  it("does not grant trusted transport to attacker-controlled result URLs", async () => {
    const origin = createTrustedServiceOrigin("http://searxng:8080");
    const [result] = await searchSearxng(origin, "argus", {
      request: async () =>
        Response.json({
          results: [
            {
              url: "http://127.0.0.1/admin",
              title: "attacker result",
              content: "not fetched",
            },
          ],
        }),
    });
    expect(result?.url).toBe("http://127.0.0.1/admin");
    await expect(
      safeHttpGet(result?.url ?? "", {
        resolver: async () => [
          { address: "93.184.216.34", family: 4 as const },
        ],
        request: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "WEB_DESTINATION_NOT_PUBLIC" });
  });
});

describe("safe web requests", () => {
  const publicAnswer = [{ address: "93.184.216.34", family: 4 as const }];

  it("accepts public addresses and rejects non-public address classes", () => {
    expect(isPublicIpAddress("93.184.216.34")).toBe(true);
    for (const address of [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "192.0.2.1",
      "198.18.0.1",
      "198.51.100.1",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "fc00::1",
      "fe80::1",
      "ff00::1",
      "2001:db8::1",
      "3fff::1",
    ]) {
      expect(isPublicIpAddress(address), address).toBe(false);
    }
    expect(isPublicIpAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(
      true,
    );
  });

  it("rejects private and mixed DNS answers before requesting", async () => {
    const request = vi.fn();
    await expect(
      safeHttpGet("https://private.example", {
        resolver: async () => [{ address: "10.0.0.1", family: 4 }],
        request,
      }),
    ).rejects.toMatchObject({ code: "WEB_DESTINATION_NOT_PUBLIC" });
    await expect(
      safeHttpGet("https://mixed.example", {
        resolver: async () => [
          ...publicAnswer,
          { address: "::1", family: 6 },
        ],
        request,
      }),
    ).rejects.toMatchObject({ code: "WEB_DESTINATION_NOT_PUBLIC" });
    expect(request).not.toHaveBeenCalled();
  });

  it("normalizes unusual IPv4 forms before resolving", async () => {
    const request = vi.fn();
    const resolver = vi.fn(async () => publicAnswer);
    for (const value of [
      "http://0177.0.0.1/",
      "http://2130706433/",
      "http://0x7f000001/",
    ]) {
      await expect(
        safeHttpGet(value, {
          resolver,
          request,
        }),
      ).rejects.toMatchObject({ code: "WEB_DESTINATION_NOT_PUBLIC" });
    }
    expect(resolver).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("pins the validated DNS answer used by the request", async () => {
    const resolver = vi
      .fn()
      .mockResolvedValueOnce(publicAnswer)
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const pinned = { approved: publicAnswer };
    const dispatcherFactory = vi.fn(() => pinned);
    const request = vi.fn(async (_url, init) => {
      expect(init.dispatcher).toBe(pinned);
      return new Response("ok", { status: 200 });
    });

    await expect(
      safeHttpGet("https://public.example/data", {
        resolver,
        dispatcherFactory,
        request,
      }),
    ).resolves.toMatchObject({
      finalUrl: "https://public.example/data",
      body: "ok",
    });
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("enforces one hard deadline while response headers are stalled", async () => {
    const close = vi.fn(async () => undefined);
    const started = Date.now();
    await expect(
      safeHttpGet("https://public.example/stalled-headers", {
        resolver: async () => publicAnswer,
        dispatcherFactory: () => ({ close }),
        timeoutMs: 20,
        request: async () => await new Promise<Response>(() => undefined),
      }),
    ).rejects.toMatchObject({ code: "WEB_REQUEST_FAILED" });

    expect(Date.now() - started).toBeLessThan(250);
    expect(close).toHaveBeenCalledOnce();
  });

  it("enforces the same hard deadline while body and cancellation are stalled", async () => {
    const close = vi.fn(async () => undefined);
    const body = new ReadableStream<Uint8Array>({
      pull: async () => await new Promise<void>(() => undefined),
      cancel: async () => await new Promise<void>(() => undefined),
    });
    const started = Date.now();
    await expect(
      safeHttpGet("https://public.example/stalled-body", {
        resolver: async () => publicAnswer,
        dispatcherFactory: () => ({ close }),
        timeoutMs: 20,
        request: async () => new Response(body),
      }),
    ).rejects.toMatchObject({ code: "WEB_REQUEST_FAILED" });

    expect(Date.now() - started).toBeLessThan(250);
    expect(close).toHaveBeenCalledOnce();
  });

  it("bounds response bytes independently of transport behavior", async () => {
    await expect(
      safeHttpGet("https://public.example/large", {
        resolver: async () => publicAnswer,
        maxBodyBytes: 4,
        request: async () => new Response("12345"),
      }),
    ).rejects.toMatchObject({ code: "WEB_RESPONSE_TOO_LARGE" });
  });

  it("revalidates redirects and blocks a public-to-private hop", async () => {
    const resolver = vi
      .fn()
      .mockResolvedValueOnce(publicAnswer)
      .mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    const request = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://metadata.example/latest" },
      }),
    );

    await expect(
      safeHttpGet("https://public.example/start", { resolver, request }),
    ).rejects.toMatchObject({ code: "WEB_DESTINATION_NOT_PUBLIC" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("handles relative redirects and returns the final canonical URL", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: "/final" },
        }),
      )
      .mockResolvedValueOnce(new Response("done", { status: 200 }));

    await expect(
      safeHttpGet("https://public.example/start", {
        resolver: async () => publicAnswer,
        request,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        finalUrl: "https://public.example/final",
        body: "done",
      }),
    );
  });

  it("rejects loops, excess redirects, credentials, and unsafe protocols", async () => {
    const resolver = async () => publicAnswer;
    const loopRequest = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: "/start" } }),
    );
    await expect(
      safeHttpGet("https://public.example/start", {
        resolver,
        request: loopRequest,
      }),
    ).rejects.toMatchObject({ code: "WEB_REDIRECT_LOOP" });

    const redirectRequest = vi.fn(async (_url: URL) =>
      new Response(null, {
        status: 302,
        headers: { location: `/next-${redirectRequest.mock.calls.length}` },
      }),
    );
    await expect(
      safeHttpGet("https://public.example/start", {
        resolver,
        request: redirectRequest,
        maxRedirects: 2,
      }),
    ).rejects.toMatchObject({ code: "WEB_TOO_MANY_REDIRECTS" });

    for (const value of [
      "https://user:pass@public.example/",
      "file:///etc/passwd",
      "ftp://public.example/file",
    ]) {
      await expect(
        safeHttpGet(value, { resolver, request: vi.fn() }),
      ).rejects.toMatchObject({ code: "WEB_DESTINATION_INVALID" });
    }

    await expect(
      safeHttpGet("https://public.example/start", {
        resolver,
        request: async () =>
          new Response(null, {
            status: 302,
            headers: { location: "http://public.example/insecure" },
          }),
      }),
    ).rejects.toMatchObject({ code: "WEB_REDIRECT_INVALID" });
  });

  it("applies the public policy to normal page and feed ingestion", async () => {
    const request = vi.fn();
    const adapter = new WebAdapter({
      resolver: async () => [{ address: "127.0.0.1", family: 4 }],
      request,
    });

    for (const config of [
      { kind: "url" as const, value: "https://blocked.example/page" },
      { kind: "feed" as const, value: "https://blocked.example/feed" },
    ]) {
      const pull = adapter.pull({
        config,
        targetId: "test",
      })[Symbol.asyncIterator]();
      await expect(pull.next()).rejects.toMatchObject({
        code: "WEB_DESTINATION_NOT_PUBLIC",
      });
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("uses the final validated URL as the page canonical URL", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "/article" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          "<html><head><title>Final</title></head><body><article>Body</article></body></html>",
        ),
      );
    const adapter = new WebAdapter({
      resolver: async () => publicAnswer,
      request,
    });
    const pull = adapter
      .pull({
        config: { kind: "url", value: "https://public.example/start" },
        targetId: "test",
      })
      [Symbol.asyncIterator]();

    await expect(pull.next()).resolves.toMatchObject({
      value: {
        externalId: "https://public.example/article",
        url: "https://public.example/article",
      },
    });
  });
});
