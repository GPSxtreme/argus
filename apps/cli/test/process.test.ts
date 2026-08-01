import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const executable = join(repositoryRoot, "node_modules", ".bin", "tsx");
const entrypoint = join(repositoryRoot, "apps", "cli", "src", "main.ts");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

const runProcess = async (
  args: string[],
  options: {
    installRoot?: string;
    cwd?: string;
    environment?: Record<string, string>;
  } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, [entrypoint, ...args], {
      cwd: options.cwd ?? repositoryRoot,
      env: {
        ...process.env,
        ...(options.installRoot
          ? { ARGUS_INSTALL_ROOT: options.installRoot }
          : {}),
        ...options.environment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });

describe("direct CLI process contracts", () => {
  it.each([
    ["unknown option", ["status", "--unknown", "--json"]],
    ["missing argument", ["repair", "--json"]],
    ["JSON before command", ["--json", "status", "--unknown"]],
    ["JSON between commands", ["config", "--json", "unknown"]],
  ])("renders %s as JSON-only stable usage failure", async (_name, args) => {
    const result = await runProcess(args);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      contractVersion: 1,
      ok: false,
      error: {
        code: "CLI_USAGE_ERROR",
        message: "The command arguments are invalid.",
        recovery: "Run 'argus --help' to inspect valid commands.",
      },
    });
  });

  it("renders JSON help without Commander process exit or stderr", async () => {
    const result = await runProcess(["config", "schema", "--help", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({
      contractVersion: 1,
      ok: true,
      data: { help: expect.stringContaining("Usage:") },
    });
  });

  it("redacts process-env, file, overlapping, and derived config secrets from a fresh cwd", async () => {
    const installRoot = await mkdtemp(join(tmpdir(), "argus-process-root-"));
    const freshCwd = await mkdtemp(join(tmpdir(), "argus-process-cwd-"));
    temporaryDirectories.push(installRoot, freshCwd);
    const longSecret = "overlap-secret-long";
    const shortSecret = "secret";
    const credentialUrl = `https://user:${longSecret}@example.com/api`;
    await writeFile(
      join(installRoot, "argus.yaml"),
      `version: 1
runtime: { role: all }
storage: { adapter: sqlite, url: "${join(installRoot, "argus.db")}" }
sources:
  x: { enabled: true, endpoint: "\${CREDENTIAL_URL}" }
  telegram: { enabled: false, adapter: public-web }
  web: { enabled: false, userAgent: Argus/0.1, browserFallback: false }
watches: []
intelligence:
  enabled: true
  provider: openrouter
  apiKey: "\${OPENROUTER_API_KEY}"
  model: openai/gpt-4.1-mini
  processors: []
api:
  host: 0.0.0.0
  port: 8788
  token: "\${ARGUS_API_TOKEN}"
`,
      { mode: 0o644 },
    );
    const secretsPath = join(installRoot, "secrets.env");
    await writeFile(
      secretsPath,
      `ARGUS_API_TOKEN=${longSecret}\nSHORT_SECRET=${shortSecret}\n`,
      { mode: 0o600 },
    );
    await chmod(secretsPath, 0o600);

    const result = await runProcess(["config", "show", "--json"], {
      installRoot,
      cwd: freshCwd,
      environment: {
        OPENROUTER_API_KEY: "openrouter-process-sentinel",
        CREDENTIAL_URL: credentialUrl,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    for (const forbidden of [
      longSecret,
      shortSecret,
      credentialUrl,
      "openrouter-process-sentinel",
    ]) {
      expect(result.stdout).not.toContain(forbidden);
    }
    const config = JSON.parse(result.stdout).data;
    expect(config.api.token).toBe("[REDACTED]");
    expect(config.intelligence.apiKey).toBe("[REDACTED]");
    expect(config.sources.x.endpoint).toBe("[REDACTED]");

    const validated = await runProcess(["config", "validate", "--json"], {
      installRoot,
      cwd: freshCwd,
      environment: {
        OPENROUTER_API_KEY: "openrouter-process-sentinel",
        CREDENTIAL_URL: credentialUrl,
      },
    });
    expect(validated.exitCode).toBe(0);
    expect(JSON.parse(validated.stdout).data.valid).toBe(true);

    const applied = await runProcess(
      ["config", "apply", "--yes", "--json"],
      {
        installRoot,
        cwd: freshCwd,
        environment: {
          OPENROUTER_API_KEY: "openrouter-process-sentinel",
          CREDENTIAL_URL: credentialUrl,
        },
      },
    );
    expect(applied.exitCode).toBe(0);
    expect(applied.stderr).toBe("");
    expect(JSON.parse(applied.stdout)).toMatchObject({
      ok: true,
      data: { result: { applied: true, verified: true } },
    });
  });
});
