import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { source } from "../lib/source";

const docsRoot = path.join(process.cwd(), "apps/web/content/docs");

const positiveLoopbackRecommendationPatterns = [
  /(?<!do not )\b(?:use|bind|set|configure|prefer|recommend)\b(?:(?!\bdo not\b|[.!?\n]).){0,100}(?:(?<!non-)\bloopback\b|\blocalhost\b|\b127\.0\.0\.1\b)/iu,
  /(?<!do not )\b(?:use|bind|set|configure|prefer|recommend)\b(?:(?!\bdo not\b|[.!?\n]).){0,100}\bapi\.host\s*:?\s*(?:127\.0\.0\.1|localhost)\b/iu,
] as const;

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

function explicitH1TitlePattern(title: string): RegExp {
  return new RegExp(`^# ${escapeRegExp(title)}$`, "mu");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

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
  it("recognizes positive loopback API recommendations without rejecting warnings", () => {
    for (const unsafe of [
      "Use localhost for the API.",
      "Bind the API to 127.0.0.1.",
      "Set api.host: 127.0.0.1.",
      "Use api.host: 127.0.0.1.",
      "Configure a loopback API host.",
      "Prefer a loopback host.",
      "Recommend localhost for API access.",
    ]) {
      expect(positiveLoopbackRecommendationPatterns.some((pattern) => pattern.test(unsafe))).toBe(true);
    }
    for (const safe of [
      "Do not bind the managed Compose API to 127.0.0.1.",
      "Do not set api.host: 127.0.0.1.",
      "Do not rely on a loopback API host for a managed Compose instance.",
    ]) {
      expect(positiveLoopbackRecommendationPatterns.some((pattern) => pattern.test(safe))).toBe(false);
    }
  });

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

  it("links repository readers to public documentation and releases", async () => {
    const readme = await readFile(path.join(process.cwd(), "README.md"), "utf8");

    expect(readme).not.toContain("The token is needed only while the release repository is private");
    expect(readme).not.toContain('ARGUS_GITHUB_TOKEN="<GitHub token with read access>"');
    expect(readme).toContain("https://argus.gpsxtre.me/docs/quick-start");
    expect(readme).toContain("https://argus.gpsxtre.me/docs/contributing");
    expect(readme).toContain("https://github.com/GPSxtreme/argus/releases/tag/v0.1.13");
  });

  it("gives each document a title and description", () => {
    for (const page of source.getPages()) {
      expect(page.data.title).toEqual(expect.any(String));
      expect(page.data.description).toEqual(expect.any(String));
      expect(page.data.title).not.toBe("");
      expect(page.data.description).not.toBe("");
    }
  });

  it("does not repeat front-matter titles as explicit H1 content", async () => {
    for (const page of source.getPages()) {
      const relativePath = page.slugs.length === 0 ? "index" : page.slugs.join("/");
      const content = await readFile(path.join(docsRoot, `${relativePath}.mdx`), "utf8").catch(() =>
        readFile(path.join(docsRoot, relativePath, "index.mdx"), "utf8"),
      );

      expect(content).not.toMatch(explicitH1TitlePattern(page.data.title));
    }
  });

  it("matches explicit H1 titles containing regular-expression characters literally", () => {
    const title = "C++ (v2)";
    const pattern = explicitH1TitlePattern(title);

    expect(pattern.test(`# ${title}`)).toBe(true);
    expect(pattern.test("# C")).toBe(false);
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
    const [deployment, operations, security, troubleshooting] = await Promise.all([
      readFile(path.join(docsRoot, "deployment.mdx"), "utf8"),
      readFile(path.join(docsRoot, "operations.mdx"), "utf8"),
      readFile(path.join(docsRoot, "security.mdx"), "utf8"),
      readFile(path.join(docsRoot, "troubleshooting.mdx"), "utf8"),
    ]);
    const backupCorpus = `${deployment}\n${operations}`;
    const exposureCorpus = `${deployment}\n${operations}\n${security}`;

    expect(deployment).toMatch(
      /ARGUS_INSTALL_INSPECT=1 sh \/tmp\/argus-install\.sh[\s\S]*sh \/tmp\/argus-install\.sh/u,
    );
    expect(deployment).not.toMatch(
      /curl -fsSL https:\/\/argus\.gpsxtre\.me\/install\.sh \| sh/u,
    );
    expect(backupCorpus).toMatch(
      /argus_argus-data[\s\S]{0,300}(?:snapshot|back up)[\s\S]{0,300}(?:atomically restores|atomically select)/iu,
    );
    expect(backupCorpus).toMatch(
      /operator(?:-|\s)managed[\s\S]{0,120}(?:Docker(?:-|\s)volume|argus_argus-data)[\s\S]{0,80}backup/iu,
    );
    expect(exposureCorpus).toMatch(
      /(?:Internet-facing|publicly reachable)[\s\S]{0,300}(?:host )?firewall[\s\S]{0,160}reverse proxy[\s\S]{0,160}private network policy/iu,
    );
    for (const recommendation of positiveLoopbackRecommendationPatterns) {
      expect(exposureCorpus).not.toMatch(recommendation);
    }
    expect(operations).toMatch(
      /\{\s*state:\s*"running"\s*\|\s*"degraded",\s*services:\s*\{\s*\.\.\.\s*\}\s*\}/u,
    );
    expect(operations).toMatch(/Docker health when present, otherwise Docker state/iu);
    expect(operations).not.toMatch(/healthy:\s*boolean/iu);
    expect(troubleshooting).toMatch(
      /dry-run[\s\S]{0,120}does not validate[\s\S]{0,100}persisted backup/iu,
    );
    expect(troubleshooting).toMatch(
      /argus onboard --from \/path\/to\/answers\.yaml --dry-run --json[\s\S]{0,160}review[\s\S]{0,160}argus onboard --from \/path\/to\/answers\.yaml --yes --json/iu,
    );
    expect(troubleshooting).not.toMatch(/dry-run returns a valid rollback plan/iu);
    expect(troubleshooting).toMatch(
      /UPDATE_ROLLBACK_UNAVAILABLE[\s\S]{0,300}persisted update state[\s\S]{0,80}(?:missing|unreadable)/iu,
    );
    expect(troubleshooting).toMatch(
      /UPDATE_ROLLBACK_INCOMPATIBLE[\s\S]{0,160}(?:no backup|backup[\s\S]{0,80}(?:absent|incompatible))/iu,
    );
    expect(troubleshooting).toMatch(
      /UPDATE_ROLLBACK_UNAVAILABLE[\s\S]{0,240}rollback support[\s\S]{0,80}unavailable/iu,
    );
    expect(troubleshooting).toMatch(
      /UPDATE_ROLLBACK_UNAVAILABLE[\s\S]{0,260}no verified rollback release[\s\S]{0,40}selected/iu,
    );
    expect(troubleshooting).toMatch(
      /UPDATE_ROLLBACK_UNAVAILABLE[\s\S]{0,360}(?:signed release context|persisted update state)[\s\S]{0,100}(?:missing|unreadable|invalid)/iu,
    );
    expect(troubleshooting).toMatch(
      /UPDATE_ROLLBACK_UNAVAILABLE[\s\S]{0,500}(?:escapes|outside)[\s\S]{0,80}instance root/iu,
    );
    for (const rollbackDocumentation of [operations, troubleshooting]) {
      expect(rollbackDocumentation).toMatch(
        /UPDATE_ROLLBACK_UNAVAILABLE[\s\S]{0,120}required rollback support or recovery material[\s\S]{0,240}(?:missing|unreadable|invalid)[\s\S]{0,120}(?:escapes|outside)[\s\S]{0,80}instance root/iu,
      );
      expect(rollbackDocumentation).toMatch(
        /UPDATE_ROLLBACK_INCOMPATIBLE[\s\S]{0,120}readable persisted update state[\s\S]{0,180}(?:no backup|backup\/release pairing)/iu,
      );
      expect(rollbackDocumentation).not.toMatch(
        /UPDATE_ROLLBACK_UNAVAILABLE[\s\S]{0,180}(?:no usable persisted backup|(?:no|absent|missing) persisted backup)/iu,
      );
    }
    for (const requirement of [
      "Ubuntu 22.04",
      "Ubuntu 24.04",
      "Ubuntu 25.10",
      "Ubuntu 26.04",
      "Debian 12",
      "Debian 13",
    ]) {
      expect(deployment).toContain(requirement);
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
