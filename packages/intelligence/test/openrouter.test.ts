import { describe, expect, it, vi } from "vitest";
import { OpenRouterClient } from "../src/index.js";

describe("OpenRouter intelligence", () => {
  it("creates a sourced summary from canonical records", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id: "generation-1",
        choices: [{ message: { content: "Argus shipped. [1]" } }],
        model: "openai/gpt-4.1-mini",
      }),
    );
    const client = new OpenRouterClient({
      apiKey: "secret",
      model: "openai/gpt-4.1-mini",
      fetcher,
    });
    const result = await client.summarize([
      {
        id: "web:argus:1",
        source: "web",
        externalId: "1",
        url: "https://example.com/1",
        text: "Argus shipped",
        raw: {},
        contentHash: "hash",
        firstSeenAt: "2026-07-31T00:00:00.000Z",
        lastSeenAt: "2026-07-31T00:00:00.000Z",
      },
    ]);
    expect(result.content).toBe("Argus shipped. [1]");
    expect(result.sources).toEqual([
      { index: 1, recordId: "web:argus:1", url: "https://example.com/1" },
    ]);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer secret",
    });
  });
});
