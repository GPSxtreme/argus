import { PostgresRepository, createPool } from "./repo.js";

export const createPostgresRepository = async (input: {
  connectionString: string;
}): Promise<PostgresRepository> => {
  const repository = new PostgresRepository(createPool(input.connectionString));
  await repository.migrate();
  return repository;
};

export { PostgresRepository } from "./repo.js";
