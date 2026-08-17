import { describe, expect, it } from "vitest";
import type { CommandExecutor, CommandResult } from "../src/index.js";
import * as deployment from "../src/index.js";

type InspectSqliteVolume = (input: {
  root: string;
  executor: CommandExecutor;
  environment: Record<string, string>;
}) => Promise<{
  name: string;
  project: "argus";
  logicalName: "argus-data";
  destination: "/app/data";
}>;

const inspectSqliteVolume = (): InspectSqliteVolume =>
  (
    deployment as typeof deployment & {
      inspectSqliteVolume: InspectSqliteVolume;
    }
  ).inspectSqliteVolume;

interface RecordedCall {
  command: string;
  args: string[];
  options:
    | {
        cwd?: string;
        env?: Record<string, string>;
        timeoutMs?: number;
      }
    | undefined;
}

const result = (stdout = ""): CommandResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
});

const scriptedExecutor = (...results: CommandResult[]) => {
  const calls: RecordedCall[] = [];
  const executor: CommandExecutor = {
    async run(command, args, options) {
      calls.push({ command, args, options });
      const next = results.shift();
      if (!next) throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      return next;
    },
  };
  return { calls, executor };
};

const root = "/opt/argus";
const environment = {
  ARGUS_API_PORT: "8788",
  ARGUS_IMAGE: `ghcr.io/gpsxtreme/argus@sha256:${"a".repeat(64)}`,
  POSTGRES_IMAGE: `postgres@sha256:${"b".repeat(64)}`,
  SEARXNG_IMAGE: `searxng@sha256:${"c".repeat(64)}`,
};
const containerId = "d".repeat(64);
const validMount = {
  Type: "volume",
  Name: "argus_argus-data",
  Source: "/var/lib/docker/volumes/argus_argus-data/_data",
  Destination: "/app/data",
  Driver: "local",
  Mode: "rw",
  RW: true,
  Propagation: "",
};
const validLabels = {
  "com.docker.compose.project": "argus",
  "com.docker.compose.volume": "argus-data",
  "com.docker.compose.version": "2.39.1",
};

describe("managed SQLite volume discovery", () => {
  it("returns the exact Compose-owned named volume mounted at /app/data", async () => {
    const { calls, executor } = scriptedExecutor(
      result(`${containerId}\n`),
      result(JSON.stringify([validMount])),
      result(JSON.stringify(validLabels)),
    );

    await expect(
      inspectSqliteVolume()({ root, executor, environment }),
    ).resolves.toEqual({
      name: "argus_argus-data",
      project: "argus",
      logicalName: "argus-data",
      destination: "/app/data",
    });
    expect(calls).toEqual([
      {
        command: "docker",
        args: ["compose", "-p", "argus", "ps", "-q", "argus"],
        options: { cwd: root, env: environment, timeoutMs: 10_000 },
      },
      {
        command: "docker",
        args: ["inspect", "--format", "{{json .Mounts}}", containerId],
        options: { timeoutMs: 10_000 },
      },
      {
        command: "docker",
        args: [
          "volume",
          "inspect",
          "--format",
          "{{json .Labels}}",
          "argus_argus-data",
        ],
        options: { timeoutMs: 10_000 },
      },
    ]);
  });

  it.each([
    ["missing service", ""],
    ["multiple service containers", `${containerId}\n${"e".repeat(64)}\n`],
    ["malformed service identity", "../../host\n"],
  ])("rejects %s before inspecting mounts", async (_name, stdout) => {
    const { calls, executor } = scriptedExecutor(result(stdout));

    await expect(
      inspectSqliteVolume()({ root, executor, environment }),
    ).rejects.toMatchObject({
      code: "UPDATE_SQLITE_VOLUME_UNAVAILABLE",
    });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["no data mount", [{ ...validMount, Destination: "/other" }]],
    ["two data mounts", [validMount, { ...validMount, Name: "other" }]],
    ["host bind", [{ ...validMount, Type: "bind", Name: undefined }]],
    ["empty volume name", [{ ...validMount, Name: "" }]],
    ["unsafe volume name", [{ ...validMount, Name: "../../host" }]],
  ])("rejects %s before inspecting volume labels", async (_name, mounts) => {
    const { calls, executor } = scriptedExecutor(
      result(containerId),
      result(JSON.stringify(mounts)),
    );

    await expect(
      inspectSqliteVolume()({ root, executor, environment }),
    ).rejects.toMatchObject({
      code: "UPDATE_SQLITE_VOLUME_UNAVAILABLE",
    });
    expect(calls).toHaveLength(2);
  });

  it.each([
    ["missing labels", null],
    ["wrong project", { ...validLabels, "com.docker.compose.project": "other" }],
    [
      "wrong logical volume",
      { ...validLabels, "com.docker.compose.volume": "postgres-data" },
    ],
  ])("rejects %s", async (_name, labels) => {
    const { calls, executor } = scriptedExecutor(
      result(containerId),
      result(JSON.stringify([validMount])),
      result(JSON.stringify(labels)),
    );

    await expect(
      inspectSqliteVolume()({ root, executor, environment }),
    ).rejects.toMatchObject({
      code: "UPDATE_SQLITE_VOLUME_UNAVAILABLE",
    });
    expect(calls).toHaveLength(3);
  });

  it.each([
    ["compose failure", [{ exitCode: 1, stdout: "", stderr: "denied" }]],
    [
      "mount inspection timeout",
      [result(containerId), { exitCode: 1, stdout: "", stderr: "", timedOut: true }],
    ],
    [
      "malformed mount JSON",
      [result(containerId), result("not-json")],
    ],
    [
      "label inspection failure",
      [
        result(containerId),
        result(JSON.stringify([validMount])),
        { exitCode: 1, stdout: "", stderr: "denied" },
      ],
    ],
  ])("fails closed on %s", async (_name, responses) => {
    const { executor } = scriptedExecutor(...(responses as CommandResult[]));

    await expect(
      inspectSqliteVolume()({ root, executor, environment }),
    ).rejects.toMatchObject({
      code: "UPDATE_SQLITE_VOLUME_UNAVAILABLE",
      recovery: expect.stringContaining("argus doctor --json"),
    });
  });
});
