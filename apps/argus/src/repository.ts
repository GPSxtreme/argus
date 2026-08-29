import { assertCanonicalPostgresUrl, type ArgusConfig } from "@argus/config";
import type { StorageRepository } from "@argus/contracts";
import { createPostgresRepository } from "@argus/storage-postgres";
import { createSqliteRepository } from "@argus/storage-sqlite";
import { join } from "node:path";

export interface RepositoryHandle {
  repository: StorageRepository;
  close(): Promise<void>;
}

export const openRepository = async (
  config: ArgusConfig,
  migrationRoot = process.env.ARGUS_MIGRATIONS_ROOT,
): Promise<RepositoryHandle> => {
  if (config.storage.adapter === "sqlite") {
    const repository = await createSqliteRepository({
      filename: config.storage.url,
      ...(migrationRoot === undefined
        ? {}
        : { migrationFile: join(migrationRoot, "sqlite.sql") }),
    });
    return {
      repository,
      close: async () => repository.close(),
    };
  }
  assertCanonicalPostgresUrl(config.storage.url);
  const repository = await createPostgresRepository({
    connectionString: config.storage.url,
    ...(migrationRoot === undefined
      ? {}
      : { migrationFile: join(migrationRoot, "postgres.sql") }),
  });
  return {
    repository,
    close: async () => repository.close(),
  };
};
