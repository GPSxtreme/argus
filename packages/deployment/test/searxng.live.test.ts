import { describe, expect, it } from "vitest";
import { checkSearxngHealth } from "../src/index.js";

const enabled = process.env.ARGUS_SEARXNG_TEST === "1";

describe.skipIf(!enabled)("managed SearXNG live smoke", () => {
  it("returns at least one JSON result", async () => {
    const endpoint = process.env.ARGUS_SEARXNG_ENDPOINT ?? "http://localhost:8080";
    const health = await checkSearxngHealth(endpoint);

    expect(health.healthy).toBe(true);
    expect(health.resultCount).toBeGreaterThan(0);
  }, 30_000);
});
