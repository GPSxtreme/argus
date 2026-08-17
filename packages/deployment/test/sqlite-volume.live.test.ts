import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CommandExecutor,
  createExecaExecutor,
  createSqliteSnapshot,
  inspectSqliteVolume,
  restoreSqliteSnapshot,
  verifySqliteSnapshot,
} from "../src/index.js";

const enabled = process.env.ARGUS_SQLITE_VOLUME_TEST === "1";
const image = process.env.ARGUS_APP_IMAGE ?? "";
const roots: string[] = [];

const createLiveExecutor = (): CommandExecutor => {
  const executor = createExecaExecutor();
  return {
    async run(command, args, options) {
      const result = await executor.run(command, args, options);
      if (result.exitCode !== 0 || result.timedOut) {
        console.error(
          JSON.stringify({
            command,
            operation: args.slice(0, 4),
            exitCode: result.exitCode,
            timedOut: result.timedOut ?? false,
            stderr: result.stderr.slice(0, 4_000),
          }),
        );
      }
      return result;
    },
  };
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const run = async (
  executor: CommandExecutor,
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
        const executor = createLiveExecutor();
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
        const readerScript = `
import Database from "better-sqlite3";
const database = new Database("/app/data/argus.db", { readonly: true, fileMustExist: true });
database.exec("BEGIN");
database.prepare("SELECT count(*) AS count FROM records").get();
process.stdout.write("ready\\n");
setInterval(() => undefined, 1_000);
`;
        const liveInspectScript = `
import Database from "better-sqlite3";
const database = new Database("/app/data/argus.db", { readonly: true, fileMustExist: true });
const records = database.prepare("SELECT count(*) AS count FROM records").get().count;
const rows = database.prepare("SELECT value FROM markers ORDER BY value").all().map(({ value }) => value);
database.close();
process.stdout.write(JSON.stringify({ records, rows }));
`;

        let ownsProject = false;
        const readerName = `argus-sqlite-wal-reader-${process.pid}-${Date.now()}`;
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
          ownsProject = true;
          await run(executor, root, [...compose, "up", "-d"]);
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
          }).catch(async (error) => {
            const snapshotPath = join(backupRoot, "argus.db");
            const directory = await lstat(backupRoot).catch(() => undefined);
            const file = await lstat(snapshotPath).catch(() => undefined);
            const readError = await readFile(snapshotPath)
              .then(() => undefined)
              .catch((cause: NodeJS.ErrnoException) => cause.code ?? "UNKNOWN");
            console.error(
              JSON.stringify({
                hostSnapshotDiagnostic: true,
                caller: {
                  uid: process.getuid?.() ?? null,
                  gid: process.getgid?.() ?? null,
                },
                directory:
                  directory === undefined
                    ? null
                    : {
                        uid: directory.uid,
                        gid: directory.gid,
                        mode: directory.mode & 0o777,
                      },
                file:
                  file === undefined
                    ? null
                    : {
                        uid: file.uid,
                        gid: file.gid,
                        mode: file.mode & 0o777,
                        size: file.size,
                      },
                readError: readError ?? null,
              }),
            );
            throw error;
          });

          await run(executor, root, [...compose, "up", "-d", "argus"]);
          await run(executor, root, [
            "run",
            "-d",
            "--name",
            readerName,
            "--network",
            "none",
            "--mount",
            `type=volume,src=${volume.name},dst=/app/data`,
            "--entrypoint",
            "node",
            image,
            "--input-type=module",
            "-e",
            readerScript,
          ]);
          let readerReady = false;
          for (let attempt = 0; attempt < 30; attempt += 1) {
            const logs = await executor.run("docker", ["logs", readerName], {
              timeoutMs: 10_000,
            });
            if (logs.exitCode === 0 && logs.stdout.includes("ready")) {
              readerReady = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          expect(readerReady).toBe(true);
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
          await expect(
            restoreSqliteSnapshot({
              root,
              backupRoot,
              snapshot,
              executor,
              environment,
              image,
              volume,
            }),
          ).rejects.toMatchObject({ code: "UPDATE_ROLLBACK_RESTORE_FAILED" });
          await run(executor, root, [
            "run",
            "--rm",
            "--network",
            "none",
            "--mount",
            `type=volume,src=${volume.name},dst=/data`,
            "--entrypoint",
            "sh",
            image,
            "-c",
            "test -f /data/argus.db-wal && test -f /data/argus.db-shm",
          ]);
          await run(executor, root, ["rm", "-f", readerName]);
          const live = JSON.parse(
            await run(executor, root, [
              "run",
              "--rm",
              "--network",
              "none",
              "--mount",
              `type=volume,src=${volume.name},dst=/app/data`,
              "--entrypoint",
              "node",
              image,
              "--input-type=module",
              "-e",
              liveInspectScript,
            ]),
          ) as { records: number; rows: string[] };
          expect(live).toEqual({
            records: 2,
            rows: ["after", "before"],
          });
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
          await executor.run("docker", ["rm", "-f", readerName], {
            timeoutMs: 10_000,
          });
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
