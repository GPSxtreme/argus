import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectConfigPath = resolve(process.cwd(), "apps/web/vercel.json");
const repositoryConfigPath = resolve(process.cwd(), "vercel.json");

describe("Vercel project configuration", () => {
  it("lives at the configured apps/web root and uses root-relative commands", () => {
    expect(existsSync(projectConfigPath)).toBe(true);
    expect(existsSync(repositoryConfigPath)).toBe(false);

    const config = JSON.parse(readFileSync(projectConfigPath, "utf8")) as Record<string, string>;
    expect(config.framework).toBe("nextjs");
    expect(config.buildCommand).toBe("pnpm build");
    expect(config.installCommand).toBe("pnpm install --frozen-lockfile");
  });
});
