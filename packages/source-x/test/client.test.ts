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
});
