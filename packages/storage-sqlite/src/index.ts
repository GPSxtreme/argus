import { openSqlite } from "./db.js";
import { SqliteRepository } from "./repo.js";

export const createSqliteRepository = async (input: {
  filename: string;
}): Promise<SqliteRepository> => new SqliteRepository(openSqlite(input.filename));

export { SqliteRepository } from "./repo.js";
