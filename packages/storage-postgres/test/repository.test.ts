import { randomUUID } from "node:crypto";
import { storageContract, type TestRepository } from "@argus/storage-test-support";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe } from "vitest";
import { createPostgresRepository } from "../src/index.js";

const enabled = Boolean(process.env.TEST_DATABASE_URL || process.env.ARGUS_POSTGRES_TEST === "1" || process.env.CI === "true");
let container: StartedPostgreSqlContainer | undefined;
let connectionString = "";

describe.skipIf(!enabled)("PostgreSQL repository", () => {
  beforeAll(async () => {
    if (process.env.TEST_DATABASE_URL) connectionString = process.env.TEST_DATABASE_URL;
    else {
      container = await new PostgreSqlContainer("postgres:17-alpine").start();
      connectionString = container.getConnectionUri();
    }
  }, 120_000);

  afterAll(async () => { await container?.stop(); });

  storageContract(async (): Promise<TestRepository> => {
    const schema = `argus_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(connectionString);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    const repository = await createPostgresRepository({ connectionString: url.toString() });
    return {
      ...repository,
      upsertRecord: repository.upsertRecord.bind(repository),
      commitIngestion: repository.commitIngestion.bind(repository),
      listRevisions: repository.listRevisions.bind(repository),
      queryRecords: repository.queryRecords.bind(repository),
      getRecord: repository.getRecord.bind(repository),
      getConversationTracking: repository.getConversationTracking.bind(repository),
      upsertConversationTracking: repository.upsertConversationTracking.bind(repository),
      listDueConversationTracking: repository.listDueConversationTracking.bind(repository),
      saveConversationSnapshot: repository.saveConversationSnapshot.bind(repository),
      queryConversationSnapshots: repository.queryConversationSnapshots.bind(repository),
      getCheckpoint: repository.getCheckpoint.bind(repository),
      setCheckpoint: repository.setCheckpoint.bind(repository),
      enqueueJob: repository.enqueueJob.bind(repository),
      claimJobs: repository.claimJobs.bind(repository),
      completeJob: repository.completeJob.bind(repository),
      failJob: repository.failJob.bind(repository),
      saveArtifact: repository.saveArtifact.bind(repository),
      queryArtifacts: repository.queryArtifacts.bind(repository),
      getAppliedConfig: repository.getAppliedConfig.bind(repository),
      applyConfig: repository.applyConfig.bind(repository),
      createDiagnosticWatch: repository.createDiagnosticWatch.bind(repository),
      getDiagnosticWatch: repository.getDiagnosticWatch.bind(repository),
      queryDiagnosticRecords: repository.queryDiagnosticRecords.bind(repository),
      commitDiagnosticIngestion: repository.commitDiagnosticIngestion.bind(repository),
      cancelDiagnosticWatch: repository.cancelDiagnosticWatch.bind(repository),
      cleanupDiagnosticWatch: repository.cleanupDiagnosticWatch.bind(repository),
      reapExpiredDiagnosticWatches: repository.reapExpiredDiagnosticWatches.bind(repository),
      close: async () => {
        await repository.close();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      },
    };
  });
});
