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
  database.exec(SQLITE_SCHEMA);
  return database;
};
