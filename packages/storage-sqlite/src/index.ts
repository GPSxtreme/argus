import { openSqlite } from "./db.js";
import { SqliteRepository } from "./repo.js";

export const createSqliteRepository = async (input: {
  filename: string;
  migrationFile?: string;
}): Promise<SqliteRepository> =>
  new SqliteRepository(openSqlite(input.filename, input.migrationFile));

export { IncompatibleStorageSchemaError, openSqlite } from "./db.js";
export { SqliteRepository } from "./repo.js";
