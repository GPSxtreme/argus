import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { source } from "../lib/source";

const docsRoot = path.join(process.cwd(), "apps/web/content/docs");

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) return markdownFiles(file);
      return entry.name.endsWith(".mdx") ? [file] : [];
    }),
  );
  return files.flat();
}

describe("Argus documentation", () => {
  it("publishes every required documentation route", () => {
    const required = [
      "/docs/getting-started",
      "/docs/configuration",
      "/docs/sources/x",
      "/docs/sources/telegram",
      "/docs/sources/web",
      "/docs/operations",
      "/docs/agents",
    ];

    expect(source.getPages().map((page) => page.url)).toEqual(
      expect.arrayContaining(required),
    );
  });

  it("gives each document a title and description", () => {
    for (const page of source.getPages()) {
      expect(page.data.title).toEqual(expect.any(String));
      expect(page.data.description).toEqual(expect.any(String));
      expect(page.data.title).not.toBe("");
      expect(page.data.description).not.toBe("");
    }
  });

  it("does not contain broken local Markdown links", async () => {
    const files = await markdownFiles(docsRoot);
    for (const file of files) {
      const content = await readFile(file, "utf8");
      const links = [...content.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/gu)];
      for (const link of links) {
        const target = link[1];
        if (target === undefined || target.startsWith("http") || target.startsWith("/")) continue;
        const resolved = path.resolve(path.dirname(file), target);
        expect(files).toContain(resolved);
      }
    }
  });
});
