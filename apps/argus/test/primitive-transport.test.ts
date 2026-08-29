import { describe, expect, it, vi } from "vitest";
import {
  PrimitiveTransportError,
  requestPrimitive,
} from "../src/primitives/transport.js";

describe("primitive transport", () => {
  it("follows same-origin redirects and emits only fixed headers", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "/final" } }),
      )
      .mockResolvedValueOnce(
        new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const result = await requestPrimitive({
      url: new URL("https://fx.example.com/start"),
      method: "GET",
      fetcher,
    });

    expect(new TextDecoder().decode(result.body)).toBe('{"ok":true}');
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      new URL("https://fx.example.com/final"),
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
        headers: {
          accept: "application/json",
          "user-agent": "Argus/0.1",
        },
      }),
    );
  });

  it("rejects cross-origin redirects", async () => {
    const fetcher = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/final" },
      }),
    );
    await expect(
      requestPrimitive({
        url: new URL("https://fx.example.com/start"),
        method: "GET",
        fetcher,
      }),
    ).rejects.toMatchObject({ code: "PRIMITIVE_REDIRECT_INVALID" });
  });

  it("rejects a response larger than two MiB", async () => {
    const fetcher = vi.fn(async () =>
      new Response("too large", {
        headers: { "content-length": String(2 * 1024 * 1024 + 1) },
      }),
    );
    await expect(
      requestPrimitive({
        url: new URL("https://fx.example.com/start"),
        method: "GET",
        fetcher,
      }),
    ).rejects.toBeInstanceOf(PrimitiveTransportError);
  });

  it("returns no response bytes for HEAD", async () => {
    const result = await requestPrimitive({
      url: new URL("https://fx.example.com/start"),
      method: "HEAD",
      fetcher: vi.fn(async () =>
        new Response(null, {
          status: 204,
          headers: { "content-type": "application/json" },
        }),
      ),
    });
    expect(result.body).toHaveLength(0);
  });
});
