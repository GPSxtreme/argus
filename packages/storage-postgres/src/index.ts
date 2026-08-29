import { PostgresRepository, createPool } from "./repo.js";

export const createPostgresRepository = async (input: {
  connectionString: string;
  migrationFile?: string;
}): Promise<PostgresRepository> => {
  const repository = new PostgresRepository(createPool(input.connectionString));
  await repository.migrate(input.migrationFile);
  return repository;
};

export { PostgresRepository } from "./repo.js";
