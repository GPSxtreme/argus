import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { renderCompose } from "../src/index.js";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../../deploy/managed/${name}`, import.meta.url));

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const composeAvailable = (() => {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

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

  it("gives Argus and SearXNG egress while fencing PostgreSQL to the private network", () => {
    const parsed = parse(
      renderCompose({ version: "0.2.0", storage: "postgres", searxng: true }),
    ) as {
      services: Record<string, { networks?: string[]; ports?: unknown[] }>;
      networks: Record<string, { internal?: boolean } | null>;
    };

    expect(parsed.services.argus?.networks).toEqual([
      "argus-private",
      "argus-egress",
    ]);
    expect(parsed.services.searxng?.networks).toEqual([
      "argus-private",
      "argus-egress",
    ]);
    expect(parsed.services.postgres?.networks).toEqual(["argus-private"]);
    expect(parsed.services.postgres?.ports).toBeUndefined();
    expect(parsed.networks["argus-private"]).toEqual({ internal: true });
    expect(parsed.networks["argus-egress"]).toEqual({});
  });

  it("runs FxEmbed privately on the VPS with egress and no published port", () => {
    const parsed = parse(
      renderCompose({
        version: "0.2.0",
        storage: "sqlite",
        searxng: false,
        fxembed: true,
      }),
    ) as {
      services: Record<
        string,
        { image?: string; networks?: string[]; ports?: unknown[] }
      >;
    };

    expect(parsed.services.fxembed).toMatchObject({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose expands this verified image variable.
      image: "${FXEMBED_IMAGE}",
      networks: ["argus-private", "argus-egress"],
    });
    expect(parsed.services.fxembed?.ports).toBeUndefined();
  });

  it("delivers only the dedicated secret file to managed SearXNG", () => {
    const parsed = parse(
      renderCompose({ version: "0.2.0", storage: "postgres", searxng: true }),
    ) as {
      services: Record<
        string,
        { env_file?: Array<{ path: string; format: string }> }
      >;
    };

    expect(parsed.services.argus?.env_file).toEqual([
      { path: "secrets.env", format: "raw" },
    ]);
    expect(parsed.services.searxng?.env_file).toEqual([
      { path: "searxng/secrets.env", format: "raw" },
    ]);
  });

  it.runIf(composeAvailable)(
    "round-trips the controlled egress topology through Docker Compose",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "argus-compose-topology-"));
      roots.push(root);
      await mkdir(join(root, "searxng"));
      await Promise.all([
        writeFile(
          join(root, "compose.yaml"),
          renderCompose({
            version: "0.2.0",
            storage: "postgres",
            searxng: true,
            fxembed: true,
          }),
        ),
        writeFile(join(root, "secrets.env"), "POSTGRES_PASSWORD=test\n"),
        writeFile(
          join(root, "searxng", "secrets.env"),
          `SEARXNG_SECRET=${"a".repeat(64)}\n`,
        ),
      ]);
      const parsed = JSON.parse(
        execFileSync(
          "docker",
          ["compose", "config", "--format", "json"],
          {
            cwd: root,
            encoding: "utf8",
            env: {
              ...process.env,
              ARGUS_API_PORT: "8788",
              ARGUS_IMAGE: `example.invalid/argus@sha256:${"a".repeat(64)}`,
              POSTGRES_IMAGE:
                `example.invalid/postgres@sha256:${"b".repeat(64)}`,
              SEARXNG_IMAGE:
                `example.invalid/searxng@sha256:${"c".repeat(64)}`,
              FXEMBED_IMAGE:
                `example.invalid/fxembed@sha256:${"d".repeat(64)}`,
            },
          },
        ),
      ) as {
        services: Record<string, { networks: Record<string, unknown> }>;
        networks: Record<string, { internal?: boolean }>;
      };

      expect(Object.keys(parsed.services.argus?.networks ?? {}).sort()).toEqual(
        ["argus-egress", "argus-private"],
      );
      expect(Object.keys(parsed.services.searxng?.networks ?? {}).sort()).toEqual(
        ["argus-egress", "argus-private"],
      );
      expect(Object.keys(parsed.services.postgres?.networks ?? {})).toEqual([
        "argus-private",
      ]);
      expect(Object.keys(parsed.services.fxembed?.networks ?? {}).sort()).toEqual(
        ["argus-egress", "argus-private"],
      );
      expect(parsed.networks["argus-private"]?.internal).toBe(true);
      expect(parsed.networks["argus-egress"]?.internal).not.toBe(true);
    },
  );
});
