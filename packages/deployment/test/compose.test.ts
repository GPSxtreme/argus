import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderCompose } from "../src/index.js";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../../deploy/managed/${name}`, import.meta.url));

describe("renderCompose", () => {
  it("renders the SQLite and managed SearXNG stack deterministically", async () => {
    expect(
      renderCompose({
        version: "0.2.0",
        storage: "sqlite",
        searxng: true,
      }),
    ).toBe(await readFile(fixture("compose.fixture.yaml"), "utf8"));
  });

  it("includes PostgreSQL only when selected and keeps managed services private", () => {
    const rendered = renderCompose({ version: "0.2.0", storage: "postgres", searxng: false });

    expect(rendered).toContain("postgres:");
    expect(rendered).not.toContain("searxng:");
    expect(rendered).toContain("internal: true");
    expect(rendered).not.toContain('"8080:8080"');
  });
});
