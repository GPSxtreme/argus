import { describe, expect, it, vi } from "vitest";
import {
  extractPage,
  parseFeed,
  searchSearxng,
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
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        results: [
          { url: "https://example.com/a", title: "A", content: "Result A" },
        ],
      }),
    );
    expect(
      await searchSearxng("http://searxng:8080", "argus", fetcher),
    ).toEqual([
      expect.objectContaining({
        externalId: "https://example.com/a",
        text: "Result A",
      }),
    ]);
  });
});
