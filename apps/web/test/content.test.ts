import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { source } from "../lib/source";

const docsRoot = path.join(process.cwd(), "apps/web/content/docs");

const requiredRoutes = [
  "/docs",
  "/docs/quick-start",
  "/docs/concepts",
  "/docs/install",
  "/docs/configuration",
  "/docs/sources/x",
  "/docs/sources/telegram",
  "/docs/sources/web",
  "/docs/intelligence",
  "/docs/api",
  "/docs/deployment",
  "/docs/operations",
  "/docs/security",
  "/docs/troubleshooting",
  "/docs/agents",
  "/docs/contributing",
  "/docs/contributing/architecture",
  "/docs/contributing/development",
  "/docs/contributing/testing",
  "/docs/contributing/releases",
  "/docs/contributing/documentation",
] as const;

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
  it("publishes the complete operator and contributor handbook", () => {
    expect(new Set(source.getPages().map((page) => page.url))).toEqual(
      expect.objectContaining({ size: requiredRoutes.length }),
    );
    expect(source.getPages().map((page) => page.url)).toEqual(
      expect.arrayContaining([...requiredRoutes]),
    );
  });

  it("separates operator and contributor navigation", async () => {
    const root = JSON.parse(
      await readFile(path.join(docsRoot, "meta.json"), "utf8"),
    );
    const contributing = JSON.parse(
      await readFile(path.join(docsRoot, "contributing/meta.json"), "utf8"),
    );

    expect(root.pages).toEqual([
      "index",
      "quick-start",
      "concepts",
      "install",
      "configuration",
      "sources",
      "intelligence",
      "api",
      "deployment",
      "operations",
      "security",
      "troubleshooting",
      "agents",
      "contributing",
    ]);
    expect(contributing.pages).toEqual([
      "index",
      "architecture",
      "development",
      "testing",
      "releases",
      "documentation",
    ]);
  });

  it("gives each document a title and description", () => {
    for (const page of source.getPages()) {
      expect(page.data.title).toEqual(expect.any(String));
      expect(page.data.description).toEqual(expect.any(String));
      expect(page.data.title).not.toBe("");
      expect(page.data.description).not.toBe("");
    }
  });

  it("gives procedural foundation pages prerequisites, verification, and next steps", async () => {
    for (const slug of ["quick-start", "install"]) {
      const content = await readFile(path.join(docsRoot, `${slug}.mdx`), "utf8");
      expect(content).toMatch(/^---[\s\S]+title:[\s\S]+description:[\s\S]+---/u);
      expect(content).toContain("## Prerequisites");
      expect(content).toContain("## Verify");
      expect(content).toContain("## Next step");
    }
  });

  it("gives the quick start its supported first-run commands", async () => {
    const quickStart = await readFile(path.join(docsRoot, "quick-start.mdx"), "utf8");
    for (const command of [
      "curl -fsSL https://argus.gpsxtre.me/install.sh | sh",
      "argus onboard",
      "argus status --json",
      "argus doctor --json",
    ]) {
      expect(quickStart).toContain(command);
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
