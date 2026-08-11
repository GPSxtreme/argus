import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { FxEmbedClient } from "../src/index.js";

describe("FxEmbed client", () => {
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
