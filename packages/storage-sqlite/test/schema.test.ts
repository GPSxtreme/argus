import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openSqlite } from "../src/db.js";

const temporaryDirectories: string[] = [];

const temporaryDatabase = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "argus-schema-v2-"));
  temporaryDirectories.push(directory);
  return join(directory, "argus.db");
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQLite schema version 2", () => {
  it("initializes an empty database with every rich-record table", () => {
    const connection = openSqlite(temporaryDatabase());
    const version = connection.database
      .prepare("SELECT version FROM schema_meta WHERE id = 1")
      .pluck()
      .get();
    const tables = connection.database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .pluck()
      .all();

    expect(version).toBe(2);
    expect(tables).toEqual([
      "applied_config",
      "artifact_media",
      "artifact_records",
      "artifacts",
      "checkpoints",
      "conversation_snapshot_items",
      "conversation_snapshots",
      "conversation_tracking",
      "diagnostic_watches",
      "engagement_snapshots",
      "jobs",
      "media_assets",
      "record_relations",
      "record_revisions",
      "record_watches",
      "records",
      "schema_meta",
    ]);
    connection.database.close();
  });

  it("rejects a version 1 database without changing it", () => {
    const filename = temporaryDatabase();
    const legacy = new Database(filename);
    legacy.exec(
      "CREATE TABLE records (id TEXT PRIMARY KEY); INSERT INTO records(id) VALUES ('legacy')",
    );
    legacy.close();

    expect(() => openSqlite(filename)).toThrowError(
      expect.objectContaining({ code: "STORAGE_SCHEMA_INCOMPATIBLE" }),
    );

    const inspected = new Database(filename, { readonly: true });
    expect(
      inspected
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .pluck()
        .all(),
    ).toEqual(["records"]);
    expect(inspected.prepare("SELECT id FROM records").pluck().all()).toEqual([
      "legacy",
    ]);
    inspected.close();
  });

  it("rejects an explicit unsupported schema version without changing it", () => {
    const filename = temporaryDatabase();
    const future = new Database(filename);
    future.exec(
      "CREATE TABLE schema_meta (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, created_at TEXT NOT NULL); INSERT INTO schema_meta VALUES (1, 3, '2026-08-29T00:00:00.000Z')",
    );
    future.close();

    expect(() => openSqlite(filename)).toThrow(/schema version 3.*reset.*re-onboard/iu);

    const inspected = new Database(filename, { readonly: true });
    expect(inspected.prepare("SELECT version FROM schema_meta").pluck().get()).toBe(3);
    inspected.close();
  });
});
