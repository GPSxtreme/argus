import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { SQLITE_SCHEMA } from "./schema.js";

export const openSqlite = (filename: string): Database.Database => {
  if (filename !== ":memory:" && !filename.startsWith("file:")) {
    mkdirSync(dirname(resolve(filename)), { recursive: true });
  }
  const database = new Database(filename);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  const hasDiagnosticWatches = (
    database
      .prepare(
        "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='diagnostic_watches'",
      )
      .get() as { found: number } | undefined
  )?.found;
  if (hasDiagnosticWatches) {
    const columns = database.pragma("table_info(diagnostic_watches)") as Array<{
      name: string;
    }>;
    if (!columns.some(({ name }) => name === "expires_at")) {
      database.exec("ALTER TABLE diagnostic_watches ADD COLUMN expires_at TEXT");
      database
        .prepare(
          `UPDATE diagnostic_watches
           SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+15 minutes')
           WHERE expires_at IS NULL`,
        )
        .run();
    }
  }
  const hasJobs = (
    database
      .prepare(
        "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='jobs'",
      )
      .get() as { found: number } | undefined
  )?.found;
  if (hasJobs) {
    const columns = database.pragma("table_info(jobs)") as Array<{
      name: string;
    }>;
    if (!columns.some(({ name }) => name === "lease_token")) {
      database.exec("ALTER TABLE jobs ADD COLUMN lease_token TEXT");
    }
  }
  database.exec(SQLITE_SCHEMA);
  return database;
};
