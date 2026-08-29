import type { ConversationSnapshot, RecordDetail, StorageRepository } from "@argus/contracts";

export interface ConversationSampleProvenance {
  rootRecordId: string;
  snapshotId: string;
  collectedAt: string;
  observedCount: number;
  retainedCount: number;
  includedReplyRecordIds: string[];
  orderBy: ConversationSnapshot["orderBy"];
  complete: boolean;
  truncated: boolean;
}

export const buildIntelligenceContext = async (
  repository: StorageRepository,
  roots: Array<{ id: string }>,
  maximumReplies = 100,
): Promise<{ records: RecordDetail[]; conversationSamples: ConversationSampleProvenance[] }> => {
  const rootDetails = (
    await Promise.all(roots.map(({ id }) => repository.getRecord(id)))
  ).filter((record): record is RecordDetail => record !== undefined);
  const seen = new Set(rootDetails.map(({ id }) => id));
  const replies: RecordDetail[] = [];
  const conversationSamples: ConversationSampleProvenance[] = [];

  for (const root of rootDetails) {
    if (replies.length >= maximumReplies) break;
    const snapshot = (await repository.queryConversationSnapshots(root.id, { limit: 1 })).items[0];
    if (!snapshot) continue;
    const includedReplyRecordIds: string[] = [];
    for (const item of snapshot.items) {
      if (replies.length >= maximumReplies) break;
      if (seen.has(item.replyRecordId)) {
        if (item.replyRecordId !== root.id) includedReplyRecordIds.push(item.replyRecordId);
        continue;
      }
      const reply = await repository.getRecord(item.replyRecordId);
      if (!reply) continue;
      seen.add(reply.id);
      replies.push(reply);
      includedReplyRecordIds.push(reply.id);
    }
    conversationSamples.push({
      rootRecordId: root.id,
      snapshotId: snapshot.id,
      collectedAt: snapshot.collectedAt,
      observedCount: snapshot.observedCount,
      retainedCount: snapshot.retainedCount,
      includedReplyRecordIds,
      orderBy: snapshot.orderBy,
      complete: snapshot.complete,
      truncated: snapshot.truncated,
    });
  }
  return { records: [...rootDetails, ...replies], conversationSamples };
};
