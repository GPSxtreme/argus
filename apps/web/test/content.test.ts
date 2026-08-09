import { readdir, readFile } from "node:fs/promises";
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

  it("documents safe operational lifecycle commands and security boundaries", async () => {
    const operationsCorpus = await readFile(
      path.join(docsRoot, "operations.mdx"),
      "utf8",
    );
    for (const command of [
      "argus start",
      "argus stop",
      "argus restart",
      "argus status --json",
      "argus logs",
      "argus doctor --json",
      "argus repair",
      "argus update --dry-run --json",
      "argus update --rollback --dry-run --json",
      "argus config apply --dry-run --json",
      "argus secrets set",
    ]) {
      expect(operationsCorpus).toContain(command);
    }

    const security = await readFile(path.join(docsRoot, "security.mdx"), "utf8");
    for (const term of ["Ed25519", "SSRF", "secrets.env", "Bearer", "least privilege"]) {
      expect(security).toContain(term);
    }
  });

  it("keeps managed Compose operator safety boundaries explicit", async () => {
    const [deployment, operations, security] = await Promise.all([
      readFile(path.join(docsRoot, "deployment.mdx"), "utf8"),
      readFile(path.join(docsRoot, "operations.mdx"), "utf8"),
      readFile(path.join(docsRoot, "security.mdx"), "utf8"),
    ]);
    const backupCorpus = `${deployment}\n${operations}`;
    const exposureCorpus = `${deployment}\n${operations}\n${security}`;

    expect(deployment).toMatch(
      /ARGUS_INSTALL_INSPECT=1 sh \/tmp\/argus-install\.sh[\s\S]*sh \/tmp\/argus-install\.sh/u,
    );
    expect(deployment).not.toMatch(
      /curl -fsSL https:\/\/argus\.gpsxtre\.me\/install\.sh \| sh/u,
    );
    expect(backupCorpus).toMatch(/argus_argus-data/u);
    expect(backupCorpus).toMatch(
      /does not (?:back up|restore) the managed named volume/iu,
    );
    expect(backupCorpus).toMatch(/operator-managed Docker-volume backup/iu);
    for (const control of ["firewall", "reverse proxy", "private network"]) {
      expect(exposureCorpus).toMatch(new RegExp(`\\b${control}\\b`, "iu"));
    }
    for (const recommendation of [
      /\bprefer\s+(?:a\s+)?loopback\b/iu,
      /\b(?:set|configure|use)\s+api\.host\s*[:=]?\s*(?:127\.0\.0\.1|localhost|::1)/iu,
      /\b(?:set|configure|use)\s+(?:a\s+)?loopback\s+(?:API\s+)?(?:host|bind)/iu,
    ]) {
      expect(exposureCorpus).not.toMatch(recommendation);
    }
    expect(operations).toMatch(/healthy:\s*boolean/iu);
    expect(operations).toMatch(/per-service Docker state and health/iu);
    expect(operations).not.toMatch(/`status` returns `running`/u);
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
