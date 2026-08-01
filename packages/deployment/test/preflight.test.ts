import { describe, expect, it } from "vitest";
import { inspectHost, type CommandExecutor, type CommandResult } from "../src/index.js";

const gibibyte = 1024 ** 3;

class FixtureExecutor implements CommandExecutor {
  constructor(private readonly fixtures: Record<string, CommandResult>) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    return this.fixtures[[command, ...args].join(" ")] ?? {
      exitCode: 1,
      stdout: "",
      stderr: "command unavailable",
    };
  }
}

const result = (stdout: string, exitCode = 0): CommandResult => ({
  exitCode,
  stdout,
  stderr: "",
});

const hostFixtures = (overrides: Record<string, CommandResult> = {}) => ({
  "cat /etc/os-release": result('ID=ubuntu\nVERSION_ID="24.04"\n'),
  "uname -m": result("aarch64\n"),
  "docker --version": result("Docker version 28.0.0, build deadbeef\n"),
  "docker compose version": result("Docker Compose version v2.35.1\n"),
  "docker info": result("Server: Docker Engine\n"),
  "free -b": result(
    "              total        used        free\nMem:     2147483648           0  2147483648\n",
  ),
  "df -B1 /": result(
    "Filesystem     1B-blocks      Used Available Use% Mounted on\n/dev/vda1 21474836480 100000000 21474836480 1% /\n",
  ),
  "ss -ltn": result("State Recv-Q Send-Q Local Address:Port Peer Address:Port\n"),
  ...overrides,
});

describe("inspectHost", () => {
  it("normalizes Ubuntu aarch64 and accepts available API ports", async () => {
    const report = await inspectHost(new FixtureExecutor(hostFixtures()), { apiPort: 8788 });

    expect(report).toMatchObject({
      supported: true,
      os: { id: "ubuntu", version: "24.04", arch: "arm64" },
      docker: { installed: true, compose: true, daemonReachable: true },
      resources: { memoryBytes: 2 * gibibyte, diskFreeBytes: 20 * gibibyte },
      ports: [{ port: 8788, available: true }],
    });
    expect(report.failures).toEqual([]);
  });

  it("reports unsupported Linux distributions", async () => {
    const report = await inspectHost(
      new FixtureExecutor(
        hostFixtures({ "cat /etc/os-release": result('ID=fedora\nVERSION_ID="42"\n') }),
      ),
    );

    expect(report.supported).toBe(false);
    expect(report.failures).toContainEqual(
      expect.objectContaining({ code: "UNSUPPORTED_OS" }),
    );
  });

  it("reports API ports already listening", async () => {
    const report = await inspectHost(
      new FixtureExecutor(
        hostFixtures({
          "ss -ltn": result(
            "State Recv-Q Send-Q Local Address:Port Peer Address:Port\nLISTEN 0 4096 0.0.0.0:8788 0.0.0.0:*\n",
          ),
        }),
      ),
      { apiPort: 8788 },
    );

    expect(report.ports).toEqual([{ port: 8788, available: false }]);
    expect(report.failures).toContainEqual(
      expect.objectContaining({ code: "PORT_IN_USE" }),
    );
  });

  it("requires 2 GiB memory for managed SearXNG and 5 GiB free disk", async () => {
    const report = await inspectHost(
      new FixtureExecutor(
        hostFixtures({
          "free -b": result("Mem:     1610612736           0  1610612736\n"),
          "df -B1 /": result(
            "Filesystem     1B-blocks      Used Available Use% Mounted on\n/dev/vda1 21474836480 100000000 4294967296 1% /\n",
          ),
        }),
      ),
      { searxngEnabled: true },
    );

    expect(report.failures.map((entry) => entry.code)).toEqual([
      "INSUFFICIENT_MEMORY",
      "INSUFFICIENT_DISK",
    ]);
  });
});
