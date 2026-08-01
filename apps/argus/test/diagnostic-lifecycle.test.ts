import { validateConfig } from "@argus/config";
import type { SourceAdapter } from "@argus/contracts";
import { targetsFromConfig } from "@argus/scheduler";
import { createSqliteRepository } from "@argus/storage-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { processNextJob } from "../src/runtime.js";

const repositories: Awaited<ReturnType<typeof createSqliteRepository>>[] = [];

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
});

const config = validateConfig({
  version: 1,
  storage: { adapter: "sqlite", url: ":memory:" },
  sources: { web: { enabled: true } },
  watches: [
    {
      id: "diagnostic-source",
      schedule: "* * * * *",
      inputs: { web: { urls: ["https://example.com/releases"] } },
    },
  ],
  api: { token: "secret" },
});

const auth = {
  authorization: "Bearer secret",
  "content-type": "application/json",
};

const createDiagnostic = async (
  app: ReturnType<typeof createApp>,
): Promise<{ id: string; targetId: string }> => {
  const response = await app.request("/v1/diagnostics/smoke-watches", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      source: "web",
      targetId: targetsFromConfig(config)[0]?.id,
    }),
  });
  expect(response.status).toBe(202);
  return response.json();
};

const fakeWebAdapter = (
  pull: SourceAdapter<unknown, unknown>["pull"],
): SourceAdapter<unknown, unknown> => ({
  kind: "web",
  capabilities: { polling: true, backfill: true, realtime: false },
  validate: async () => ({ valid: true, errors: [] }),
  pull,
});

describe("diagnostic watch lifecycle", () => {
  it("ingests through the real worker and deletes only diagnostic state", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const app = createApp({ config, repository });

    await repository.commitIngestion({
      targetId: "user-target",
      checkpoint: { lastId: "user-1" },
      records: [
        {
          id: "web:user-target:user-1",
          source: "web",
          targetId: "user-target",
          externalId: "user-1",
          url: "https://example.org/user",
          text: "user record",
          raw: {},
          watchIds: ["user-watch"],
          contentHash: "user-hash",
          ingestedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
    });
    await repository.enqueueJob({
      id: "user-job",
      targetId: "user-target",
      source: "web",
      status: "queued",
      attempt: 0,
      runAt: "2099-01-01T00:00:00.000Z",
    });
    await repository.saveArtifact({
      id: "user-artifact",
      recordIds: ["web:user-target:user-1"],
      kind: "summary",
      content: "user only",
      provenance: {},
      createdAt: "2026-08-01T00:00:00.000Z",
    });

    const diagnostic = await createDiagnostic(app);
    const adapter = fakeWebAdapter(async function* () {
      yield {
        externalId: "diagnostic-1",
        url: "https://example.com/releases",
        text: "diagnostic record",
        raw: {},
      };
    });
    expect(
      await processNextJob(config, repository, {
        adapterFactory: () => adapter,
        workerId: "diagnostic-worker",
      }),
    ).toEqual({ status: "complete" });

    const diagnosticRecords = await repository.queryDiagnosticRecords(
      diagnostic.targetId,
    );
    expect(diagnosticRecords).toHaveLength(1);
    expect(diagnosticRecords[0]?.watchIds).toEqual([diagnostic.targetId]);
    const ordinaryResponse = await app.request(
      `/v1/records?target=${encodeURIComponent(diagnostic.targetId)}`,
      { headers: auth },
    );
    expect((await ordinaryResponse.json()).items).toEqual([]);
    const diagnosticResponse = await app.request(
      `/v1/diagnostics/smoke-watches/${diagnostic.id}/records`,
      { headers: auth },
    );
    expect((await diagnosticResponse.json()).items).toHaveLength(1);
    expect(await repository.getCheckpoint(diagnostic.targetId)).toMatchObject({
      lastId: "diagnostic-1",
    });
    await repository.saveArtifact({
      id: "diagnostic-artifact",
      recordIds: [diagnosticRecords[0]?.id ?? "missing"],
      kind: "summary",
      content: "diagnostic only",
      provenance: {},
      createdAt: "2026-08-01T01:00:00.000Z",
    });
    await repository.saveArtifact({
      id: "mixed-artifact",
      recordIds: [
        "web:user-target:user-1",
        diagnosticRecords[0]?.id ?? "missing",
      ],
      kind: "summary",
      content: "mixed",
      provenance: {},
      createdAt: "2026-08-01T02:00:00.000Z",
    });

    const deleted = await app.request(
      `/v1/diagnostics/smoke-watches/${diagnostic.id}`,
      { method: "DELETE", headers: auth },
    );
    expect(deleted.status).toBe(204);
    expect(await repository.getDiagnosticWatch(diagnostic.targetId)).toBeUndefined();
    expect(await repository.queryDiagnosticRecords(diagnostic.targetId)).toEqual(
      [],
    );
    expect(await repository.getCheckpoint(diagnostic.targetId)).toBeUndefined();
    expect(await processNextJob(config, repository)).toEqual({ status: "idle" });

    expect(
      (await repository.queryRecords({ targetIds: ["user-target"] })).items,
    ).toHaveLength(1);
    expect(await repository.getCheckpoint("user-target")).toEqual({
      lastId: "user-1",
    });
    expect((await repository.queryArtifacts({})).items.map(({ id }) => id)).toEqual([
      "mixed-artifact",
      "user-artifact",
    ]);
    await repository.failJob(
      "user-job",
      "make due for assertion",
      "2026-08-01T00:00:00.000Z",
    );
    expect((await repository.claimJobs("user-worker", 1, 30_000))[0]?.id).toBe(
      "user-job",
    );
  });

  it("deleting a queued diagnostic prevents adapter execution and retry", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const app = createApp({ config, repository });
    const diagnostic = await createDiagnostic(app);
    expect(
      (
        await app.request(
          `/v1/diagnostics/smoke-watches/${diagnostic.id}`,
          { method: "DELETE", headers: auth },
        )
      ).status,
    ).toBe(204);
    const adapterFactory = vi.fn(() =>
      fakeWebAdapter(async function* () {
        yield {
          externalId: "must-not-run",
          url: "https://example.com/releases",
          text: "must not run",
          raw: {},
        };
      }),
    );
    expect(
      await processNextJob(config, repository, { adapterFactory }),
    ).toEqual({ status: "idle" });
    expect(adapterFactory).not.toHaveBeenCalled();
    expect(await repository.getDiagnosticWatch(diagnostic.targetId)).toBeUndefined();
  });

  it("deleting an in-flight diagnostic prevents commit, retry, and orphan state", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const app = createApp({ config, repository });
    const diagnostic = await createDiagnostic(app);
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const adapter = fakeWebAdapter(async function* () {
      entered();
      await barrier;
      yield {
        externalId: "late",
        url: "https://example.com/releases",
        text: "must not commit",
        raw: {},
      };
    });

    const processing = processNextJob(config, repository, {
      adapterFactory: () => adapter,
      workerId: "blocked-worker",
    });
    await started;
    expect(
      (
        await app.request(
          `/v1/diagnostics/smoke-watches/${diagnostic.id}`,
          { method: "DELETE", headers: auth },
        )
      ).status,
    ).toBe(204);
    release();

    expect(await processing).toEqual({ status: "cancelled" });
    expect(await repository.queryDiagnosticRecords(diagnostic.targetId)).toEqual(
      [],
    );
    expect(await repository.getCheckpoint(diagnostic.targetId)).toBeUndefined();
    expect(await repository.getDiagnosticWatch(diagnostic.targetId)).toBeUndefined();
    expect(await processNextJob(config, repository)).toEqual({ status: "idle" });
  });

  it("does not recreate diagnostic data when cancelled at the commit boundary", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const app = createApp({ config, repository });
    const diagnostic = await createDiagnostic(app);
    const originalCommit = repository.commitDiagnosticIngestion.bind(repository);
    let releaseCommit!: () => void;
    let enteredCommit!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enteredCommit = resolve;
    });
    repository.commitDiagnosticIngestion = async (input) => {
      enteredCommit();
      await blocked;
      return originalCommit(input);
    };
    const adapter = fakeWebAdapter(async function* () {
      yield {
        externalId: "late-boundary",
        url: "https://example.com/releases",
        text: "must not commit",
        raw: {},
      };
    });

    const processing = processNextJob(config, repository, {
      adapterFactory: () => adapter,
      workerId: "boundary-worker",
    });
    await entered;
    expect(
      (
        await app.request(
          `/v1/diagnostics/smoke-watches/${diagnostic.id}`,
          { method: "DELETE", headers: auth },
        )
      ).status,
    ).toBe(204);
    releaseCommit();

    expect(await processing).toEqual({ status: "cancelled" });
    expect(await repository.queryDiagnosticRecords(diagnostic.targetId)).toEqual(
      [],
    );
    expect(await repository.getCheckpoint(diagnostic.targetId)).toBeUndefined();
  });
});
