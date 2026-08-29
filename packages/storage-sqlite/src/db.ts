import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { sqliteSchema } from "./schema.js";

export class IncompatibleStorageSchemaError extends Error {
  readonly code = "STORAGE_SCHEMA_INCOMPATIBLE";

  constructor(version: number | "unversioned") {
    super(
      `Argus database schema version ${version} is incompatible with schema version 2; reset the database and re-onboard.`,
    );
    this.name = "IncompatibleStorageSchemaError";
  }
}

export interface SqliteConnection {
  database: Database.Database;
  orm: BetterSQLite3Database<typeof sqliteSchema>;
}

const defaultMigrationFile = fileURLToPath(
  new URL("../drizzle/0000_schema_v2.sql", import.meta.url),
);

const tableNames = (database: Database.Database): string[] =>
  database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .pluck()
    .all() as string[];

const schemaVersion = (database: Database.Database): number | undefined => {
  if (!tableNames(database).includes("schema_meta")) return undefined;
  const value = database
    .prepare("SELECT version FROM schema_meta WHERE id = 1")
    .pluck()
    .get();
  return typeof value === "number" ? value : undefined;
};

const initialize = (
  database: Database.Database,
  migrationFile: string,
): void => {
  const migration = readFileSync(migrationFile, "utf8").replaceAll(
    "--> statement-breakpoint",
    "",
  );
  database.transaction(() => database.exec(migration))();
};

export const openSqlite = (
  filename: string,
  migrationFile = defaultMigrationFile,
): SqliteConnection => {
  if (filename !== ":memory:" && !filename.startsWith("file:")) {
    mkdirSync(dirname(resolve(filename)), { recursive: true });
  }
  const database = new Database(filename);
  try {
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    const tables = tableNames(database);
    const version = schemaVersion(database);
    if (version !== undefined && version !== 2) {
      throw new IncompatibleStorageSchemaError(version);
    }
    if (version === undefined && tables.length > 0) {
      throw new IncompatibleStorageSchemaError("unversioned");
    }
    if (version === undefined) initialize(database, migrationFile);
    return {
      database,
      orm: drizzle(database, { schema: sqliteSchema }),
    };
  } catch (error) {
    database.close();
    throw error;
  }
};
