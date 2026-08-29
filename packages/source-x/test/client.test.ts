import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { FxEmbedClient, normalizeXStatus } from "../src/index.js";

const richStatus = JSON.parse(readFileSync(new URL("./fixtures/status-rich.json", import.meta.url), "utf8")) as unknown;

describe("FxEmbed client", () => {
  it("normalizes media-only posts, relations, and engagement", () => {
    expect(normalizeXStatus(richStatus)).toMatchObject({
      externalId: "190", text: "", author: "chartist",
      media: [
        { sourceMediaId: "m1", kind: "image", url: "https://cdn.example/chart.jpg", altText: "Price prediction chart" },
        { sourceMediaId: "m2", kind: "video", previewUrl: "https://cdn.example/video.jpg", durationMs: 12000 },
      ],
      relations: [
        { kind: "reply_to", objectExternalId: "100" },
        { kind: "quote_of", objectExternalId: "101" },
        { kind: "repost_of", objectExternalId: "102" },
      ],
      engagement: { likes: 44, replies: 8, reposts: 6, quotes: 3, views: 900, bookmarks: 4 },
    });
  });

  it("reads bounded conversation pages", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ tweets: [richStatus], next_cursor: "next" }));
    await expect(new FxEmbedClient("https://fx.example", fetcher).conversation("190", "first")).resolves.toMatchObject({ items: [{ externalId: "190" }], cursor: "next" });
    expect(fetcher).toHaveBeenCalledWith("https://fx.example/2/conversation/190?cursor=first", expect.anything());
  });
  it("normalizes account posts into source items", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          tweets: [
            {
              id: "190",
              text: "Argus ships",
              created_at: "2026-07-31T00:00:00.000Z",
              author: { screen_name: "argus" },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const client = new FxEmbedClient("https://fx.example/api", fetcher);
    const items = await client.account("argus");
    expect(items[0]).toMatchObject({
      externalId: "190",
      text: "Argus ships",
      author: "argus",
      url: "https://x.com/argus/status/190",
    });
  });

  it("surfaces HTTP failures with response context", async () => {
    const client = new FxEmbedClient(
      "https://fx.example/api",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response("rate limited", { status: 429 }),
      ),
    );
    await expect(client.search("argus")).rejects.toThrow("FxEmbed request failed (429)");
  });

  it("uses the real FxEmbed /2 API when its root redirects", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/") {
        response.writeHead(302, { location: "/unusable-root" });
        response.end();
        return;
      }
      if (request.url === "/2/search?query=argus") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ tweets: [{ id: "190", text: "Argus ships" }] }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server is unavailable.");
    const endpoint = `http://127.0.0.1:${address.port}`;

    try {
      await expect(fetch(endpoint, { redirect: "manual" })).resolves.toMatchObject({
        status: 302,
      });
      await expect(new FxEmbedClient(endpoint).search("argus")).resolves.toEqual([
        expect.objectContaining({ externalId: "190", text: "Argus ships" }),
      ]);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
