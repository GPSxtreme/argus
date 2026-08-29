import { describe, expect, it } from "vitest";
import {
  PrimitiveBoundaryError,
  PrimitiveRateLimiter,
  resolveWebSearchPrimitive,
  resolveXPrimitive,
} from "../src/primitives/policy.js";

describe("primitive request policy", () => {
  it("resolves only normalized v2 paths beneath the configured endpoint", () => {
    expect(
      resolveXPrimitive(
        "https://fx.example.com/api",
        "/2/status/20",
        new URLSearchParams({ cursor: "a b" }),
      ).href,
    ).toBe("https://fx.example.com/api/2/status/20?cursor=a+b");
  });

  it.each([
    "/1/status/20",
    "/2/../admin",
    "/2/%2e%2e/admin",
    "/2/%252e%252e/admin",
    "/2/%25252e%25252e/admin",
    "/2/%2525252e%2525252e/admin",
    "/2/status%2fadmin",
    `/2/${"a".repeat(4_100)}`,
  ])("rejects an unsafe X path: %s", (path) => {
    expect(() =>
      resolveXPrimitive("https://fx.example.com/api", path),
    ).toThrow(PrimitiveBoundaryError);
  });

  it.each([
    "https://user:pass@fx.example.com/api",
    "https://fx.example.com/api?next=https://evil.example",
    "https://fx.example.com/api#fragment",
  ])("rejects an unsafe configured endpoint: %s", (endpoint) => {
    expect(() => resolveXPrimitive(endpoint, "/2/status/20")).toThrow(
      PrimitiveBoundaryError,
    );
  });

  it("limits a token and source to 60 calls per minute", () => {
    const limiter = new PrimitiveRateLimiter();
    const now = Date.parse("2026-08-29T00:00:00.000Z");
    for (let request = 0; request < 60; request += 1) {
      expect(limiter.consume("token", "x", now)).toEqual({ allowed: true });
    }
    expect(limiter.consume("token", "x", now)).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
    expect(limiter.consume("token", "web", now)).toEqual({ allowed: true });
    expect(limiter.consume("token", "x", now + 60_000)).toEqual({
      allowed: true,
    });
  });

  it("forwards only documented SearXNG parameters and forces JSON", () => {
    const query = new URLSearchParams({ q: "movie news", engines: "bing,google", categories: "news", language: "en", time_range: "day", pageno: "2" });
    expect(resolveWebSearchPrimitive("http://searxng:8080/", query).href).toBe(
      "http://searxng:8080/search?q=movie+news&engines=bing%2Cgoogle&categories=news&language=en&time_range=day&pageno=2&format=json",
    );
    expect(() => resolveWebSearchPrimitive("http://searxng:8080/", new URLSearchParams({ q: "news", format: "html" }))).toThrow(PrimitiveBoundaryError);
    expect(() => resolveWebSearchPrimitive("http://searxng:8080/", new URLSearchParams({ q: "news", unsafe: "1" }))).toThrow(PrimitiveBoundaryError);
  });
});
