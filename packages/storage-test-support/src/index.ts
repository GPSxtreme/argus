import { randomUUID } from "node:crypto";
import type { IngestionRecord, StorageRepository } from "@argus/contracts";
import { contentHash, recordIdentity } from "@argus/contracts";
import { afterEach, describe, expect, it } from "vitest";

export interface TestRepository extends StorageRepository { close(): void | Promise<void> }
export type RepositoryFactory = () => Promise<TestRepository>;

const observedAt = "2026-08-29T00:00:00.000Z";
const fixture = (overrides: Partial<IngestionRecord> = {}): IngestionRecord => {
  const source = overrides.source ?? "x";
  const externalId = overrides.externalId ?? "post-9";
  const text = overrides.text ?? "Argus rich context";
  return {
    id: recordIdentity(source, externalId), source, externalId,
    targetId: "x:account:argus", watchIds: ["markets"],
    url: `https://x.com/argus/status/${externalId}`, text,
    raw: { text }, contentHash: contentHash({ text }),
    firstSeenAt: observedAt, lastSeenAt: observedAt, ...overrides,
  };
};

export const storageContract = (factory: RepositoryFactory): void => {
  const repositories: TestRepository[] = [];
  const create = async (): Promise<TestRepository> => {
    const repository = await factory(); repositories.push(repository); return repository;
  };
  afterEach(async () => { for (const repository of repositories.splice(0)) await repository.close(); });

  describe("rich storage contract", () => {
    it("stores one canonical record observed by multiple watches and targets", async () => {
      const repository = await create(); const first = fixture();
      await repository.upsertRecord(first);
      await repository.upsertRecord({ ...first, targetId: "x:search:argus", watchIds: ["alerts"], lastSeenAt: "2026-08-29T00:05:00.000Z" });
      const detail = await repository.getRecord(first.id);
      expect((await repository.queryRecords({})).items).toHaveLength(1);
      expect(detail?.watches.map(({ watchId }) => watchId).sort()).toEqual(["alerts", "markets"]);
      expect(detail?.firstSeenAt).toBe(observedAt);
      expect(detail?.lastSeenAt).toBe("2026-08-29T00:05:00.000Z");
    });

    it("stores ordered media pointers without media bytes", async () => {
      const repository = await create();
      const record = fixture({ text: "", media: [
        { kind: "image", url: "https://cdn.example/poster.jpg", width: 1200, height: 800 },
        { kind: "video", url: "https://cdn.example/trailer.mp4", previewUrl: "https://cdn.example/trailer.jpg" },
      ] });
      await repository.upsertRecord(record);
      const media = (await repository.getRecord(record.id))?.media;
      expect(media?.map(({ kind, position }) => [kind, position])).toEqual([["image", 0], ["video", 1]]);
      expect(JSON.stringify(media)).not.toContain("data:");
    });

    it("resolves a relation when its target arrives later", async () => {
      const repository = await create();
      const reply = fixture({ externalId: "reply", id: recordIdentity("x", "reply"), relations: [{ kind: "reply_to", objectSource: "x", objectExternalId: "root" }] });
      await repository.upsertRecord(reply);
      expect((await repository.getRecord(reply.id))?.relations[0]?.objectRecordId).toBeUndefined();
      const root = fixture({ externalId: "root", id: recordIdentity("x", "root") });
      await repository.upsertRecord(root);
      expect((await repository.getRecord(reply.id))?.relations[0]?.objectRecordId).toBe(root.id);
    });

    it("separates content revisions from changed engagement snapshots", async () => {
      const repository = await create();
      const first = fixture({ engagement: { likes: 10, replies: 2 } });
      await repository.upsertRecord(first);
      await repository.upsertRecord({ ...first, engagement: { likes: 10, replies: 2 }, lastSeenAt: "2026-08-29T00:05:00.000Z" });
      await repository.upsertRecord({ ...first, engagement: { likes: 20, replies: 3 }, lastSeenAt: "2026-08-29T00:10:00.000Z" });
      expect((await repository.listRevisions(first.id)).items).toHaveLength(1);
      expect((await repository.getRecord(first.id))?.latestEngagement).toMatchObject({ likes: 20, replies: 3 });
      await repository.upsertRecord({ ...first, text: "Edited context", contentHash: contentHash({ text: "Edited context" }), lastSeenAt: "2026-08-29T00:15:00.000Z" });
      expect((await repository.listRevisions(first.id)).items).toHaveLength(2);
    });

    it("stores conversation state and snapshot membership atomically", async () => {
      const repository = await create();
      const root = fixture({ externalId: "root", id: recordIdentity("x", "root") });
      const reply = fixture({ externalId: "reply", id: recordIdentity("x", "reply") });
      await repository.commitIngestion({ records: [root, reply], targetId: root.targetId, checkpoint: {} });
      await repository.upsertConversationTracking({ rootRecordId: root.id, watchId: "markets", status: "active", orderBy: "likes", maxPerPost: 50, maxTrackingHours: 168, publishedAt: observedAt, nextRunAt: observedAt, stopsAt: "2026-09-05T00:00:00.000Z", updatedAt: observedAt });
      expect((await repository.listDueConversationTracking("2026-08-29T00:01:00.000Z", 10))[0]?.rootRecordId).toBe(root.id);
      const snapshotId = randomUUID();
      await repository.saveConversationSnapshot({ snapshot: { id: snapshotId, rootRecordId: root.id, observedCount: 1, retainedCount: 1, orderBy: "likes", pagesFetched: 1, complete: true, truncated: false, collectedAt: observedAt }, items: [{ snapshotId, replyRecordId: reply.id, rank: 1, sortValue: 5 }] });
      expect((await repository.queryConversationSnapshots(root.id)).items[0]?.items).toEqual([{ snapshotId, replyRecordId: reply.id, rank: 1, sortValue: 5 }]);
    });

    it("persists normalized artifact record and media provenance", async () => {
      const repository = await create(); const record = fixture({ media: [{ kind: "image", url: "https://cdn.example/chart.jpg" }] });
      await repository.upsertRecord(record);
      const mediaAssetId = (await repository.getRecord(record.id))?.media[0]?.id;
      if (!mediaAssetId) throw new Error("Expected media asset");
      await repository.saveArtifact({ id: "summary", recordIds: [record.id], media: [{ mediaAssetId, disposition: "analyzed" }], kind: "summary", content: "Grounded summary", provenance: {}, createdAt: observedAt });
      expect((await repository.queryArtifacts({})).items[0]).toMatchObject({ recordIds: [record.id], media: [{ mediaAssetId, disposition: "analyzed" }] });
    });

    it("supports filters, cursors, checkpoints, jobs, and applied config", async () => {
      const repository = await create(); const older = fixture();
      const newer = fixture({ source: "web", externalId: "page", id: recordIdentity("web", "page"), targetId: "web:url:page", watchIds: ["news"], text: "Movie news", contentHash: contentHash({ text: "Movie news" }), lastSeenAt: "2026-08-29T01:00:00.000Z" });
      await repository.commitIngestion({ records: [older, newer], targetId: "batch", checkpoint: { cursor: 2 } });
      expect((await repository.queryRecords({ sources: ["web"], text: "Movie", watchIds: ["news"] })).items.map(({ id }) => id)).toEqual([newer.id]);
      const first = await repository.queryRecords({ limit: 1 });
      if (!first.nextCursor) throw new Error("Expected next cursor");
      expect((await repository.queryRecords({ limit: 1, cursor: first.nextCursor })).items.map(({ id }) => id)).toEqual([older.id]);
      expect(await repository.getCheckpoint("batch")).toEqual({ cursor: 2 });
      await repository.applyConfig({ config: { version: 2 }, contentHash: "hash", appliedAt: observedAt });
      expect(await repository.getAppliedConfig()).toMatchObject({ contentHash: "hash" });
      await repository.enqueueJob({ id: "job", targetId: "target", source: "web", status: "queued", attempt: 0, runAt: observedAt });
      expect(await repository.claimJobs("worker", 1, 30_000)).toHaveLength(1);
    });

    it("removes diagnostic-only observations without deleting shared canonical data", async () => {
      const repository = await create(); const diagnosticTarget = "__argus_doctor:test";
      await repository.createDiagnosticWatch({ id: "doctor", targetId: diagnosticTarget, source: "web", target: {}, status: "active", createdAt: observedAt, updatedAt: observedAt, expiresAt: "2026-08-29T01:00:00.000Z", job: { id: "doctor-job", targetId: diagnosticTarget, source: "web", status: "queued", attempt: 0, runAt: observedAt } });
      const record = fixture(); await repository.upsertRecord(record);
      await repository.upsertRecord({ ...record, targetId: diagnosticTarget, watchIds: [diagnosticTarget] });
      expect((await repository.queryRecords({})).items.map(({ id }) => id)).toEqual([record.id]);
      await repository.cleanupDiagnosticWatch(diagnosticTarget);
      expect((await repository.getRecord(record.id))?.watches).toHaveLength(1);
    });
  });
};
