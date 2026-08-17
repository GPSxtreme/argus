import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createExecaExecutor,
  createSqliteSnapshot,
  inspectSqliteVolume,
  restoreSqliteSnapshot,
  verifySqliteSnapshot,
} from "../src/index.js";

const enabled = process.env.ARGUS_SQLITE_VOLUME_TEST === "1";
const image = process.env.ARGUS_APP_IMAGE ?? "";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const run = async (
  executor: ReturnType<typeof createExecaExecutor>,
  root: string,
  args: string[],
) => {
  const result = await executor.run("docker", args, {
    cwd: root,
    timeoutMs: 120_000,
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(`Docker command failed: ${args.join(" ")}\n${result.stderr}`);
  }
  return result.stdout;
};

describe.skipIf(!enabled)(
  "real SQLite named-volume backup and restore (requires ARGUS_SQLITE_VOLUME_TEST=1 and ARGUS_APP_IMAGE)",
  () => {
    it(
      "restores prior rows and remains writable by the Argus runtime user",
      async () => {
        expect(image).toMatch(/^[^\s@]+@sha256:[a-f0-9]{64}$/u);
        const root = await mkdtemp(join(tmpdir(), "argus-sqlite-volume-live-"));
        roots.push(root);
        const backupRoot = join(root, "backups", "live");
        await mkdir(backupRoot, { recursive: true });
        await writeFile(
          join(root, "compose.yaml"),
          `services:\n  argus:\n    image: ${JSON.stringify(image)}\n    entrypoint: ["sh", "-c"]\n    command: ["sleep infinity"]\n    volumes:\n      - argus-data:/app/data\nvolumes:\n  argus-data: {}\n`,
        );
        const executor = createExecaExecutor();
        const compose = ["compose", "-p", "argus"];
        const seedScript = `
import Database from "better-sqlite3";
const database = new Database("/app/data/argus.db");
database.pragma("journal_mode = WAL");
database.exec("CREATE TABLE records (id TEXT PRIMARY KEY); CREATE TABLE revisions (id TEXT PRIMARY KEY); CREATE TABLE jobs (id TEXT PRIMARY KEY); CREATE TABLE markers (value TEXT PRIMARY KEY);");
database.prepare("INSERT INTO records VALUES (?)").run("record-before");
database.prepare("INSERT INTO revisions VALUES (?)").run("revision-before");
database.prepare("INSERT INTO jobs VALUES (?)").run("job-before");
database.prepare("INSERT INTO markers VALUES (?)").run("before");
database.close();
`;
        const mutateScript = `
import Database from "better-sqlite3";
const database = new Database("/app/data/argus.db");
database.prepare("INSERT INTO records VALUES (?)").run("record-after");
database.prepare("INSERT INTO markers VALUES (?)").run("after");
database.close();
`;
        const inspectScript = `
import Database from "better-sqlite3";
const database = new Database("/app/data/argus.db");
database.prepare("INSERT INTO markers VALUES (?)").run("restored-write");
const rows = database.prepare("SELECT value FROM markers ORDER BY value").all().map(({ value }) => value);
const records = database.prepare("SELECT count(*) AS count FROM records").get().count;
database.close();
process.stdout.write(JSON.stringify({ rows, records }));
`;

        let ownsProject = false;
        try {
          const existingContainers = await executor.run(
            "docker",
            [...compose, "ps", "-q", "--all"],
            { cwd: root, timeoutMs: 10_000 },
          );
          const existingVolume = await executor.run(
            "docker",
            ["volume", "inspect", "argus_argus-data"],
            { timeoutMs: 10_000 },
          );
          if (
            existingContainers.stdout.trim().length > 0 ||
            existingVolume.exitCode === 0
          ) {
            throw new Error(
              "Refusing to run destructive SQLite live test while an argus Compose project already exists.",
            );
          }
          await run(executor, root, [...compose, "up", "-d"]);
          ownsProject = true;
          await run(executor, root, [
            ...compose,
            "exec",
            "-T",
            "argus",
            "node",
            "--input-type=module",
            "-e",
            seedScript,
          ]);
          await expect(access(join(root, "data", "argus.db"))).rejects.toMatchObject({
            code: "ENOENT",
          });

          const environment: Record<string, string> = {};
          const volume = await inspectSqliteVolume({ root, executor, environment });
          await run(executor, root, [...compose, "stop", "argus"]);
          const snapshot = await createSqliteSnapshot({
            root,
            backupRoot,
            executor,
            environment,
            image,
            volume,
          });

          await run(executor, root, [...compose, "up", "-d", "argus"]);
          await run(executor, root, [
            ...compose,
            "exec",
            "-T",
            "argus",
            "node",
            "--input-type=module",
            "-e",
            mutateScript,
          ]);
          await run(executor, root, [...compose, "stop", "argus"]);
          await verifySqliteSnapshot({
            root,
            backupRoot,
            snapshot,
            executor,
            environment,
            image,
          });
          const stoppedVolume = await inspectSqliteVolume({
            root,
            executor,
            environment,
          });
          await restoreSqliteSnapshot({
            root,
            backupRoot,
            snapshot,
            executor,
            environment,
            image,
            volume: stoppedVolume,
          });

          await run(executor, root, [...compose, "up", "-d", "argus"]);
          const restored = JSON.parse(
            await run(executor, root, [
              ...compose,
              "exec",
              "-T",
              "argus",
              "node",
              "--input-type=module",
              "-e",
              inspectScript,
            ]),
          ) as { rows: string[]; records: number };
          expect(restored).toEqual({
            rows: ["before", "restored-write"],
            records: 1,
          });
        } finally {
          if (ownsProject) {
            await run(executor, root, [
              ...compose,
              "down",
              "--volumes",
              "--remove-orphans",
            ]).catch(() => undefined);
          }
        }
      },
      180_000,
    );
  },
);
