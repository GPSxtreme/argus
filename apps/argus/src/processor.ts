import { randomUUID } from "node:crypto";
import type { ArgusConfig } from "@argus/config";
import type {
  RecordDetail,
  RecordEnvelope,
  StorageRepository,
} from "@argus/contracts";
import {
  OpenRouterClient,
  type SourcedSummary,
} from "@argus/intelligence";
import { buildIntelligenceContext } from "./intelligence-context.js";

type Processor = ArgusConfig["intelligence"]["processors"][number];
interface SummaryClient {
  summarize(
    records: Array<RecordEnvelope | RecordDetail>,
    prompt?: string,
  ): Promise<SourcedSummary>;
}

export const runSummaryProcessor = async (
  processor: Processor,
  config: ArgusConfig,
  repository: StorageRepository,
  client: SummaryClient = new OpenRouterClient({
    apiKey: config.intelligence.apiKey as string,
    model: config.intelligence.model,
  }),
): Promise<SourcedSummary> => {
  if (!config.intelligence.enabled || !config.intelligence.apiKey) {
    throw new Error("Intelligence is disabled");
  }
  const records = await repository.queryRecords({
    ...(processor.watchIds ? { watchIds: processor.watchIds } : {}),
    limit: 100,
  });
  const context = await buildIntelligenceContext(repository, records.items);
  const result = await client.summarize(context.records, processor.prompt);
  await repository.saveArtifact({
    id: randomUUID(),
    recordIds: context.records.map((record) => record.id),
    media: result.media.map(({ mediaAssetId, disposition }) => ({
      mediaAssetId,
      disposition,
    })),
    kind: "summary",
    content: result.content,
    provider: "openrouter",
    model: result.model,
    provenance: {
      processorId: processor.id,
      sources: result.sources,
      capabilitiesSource: result.capabilitiesSource,
      media: result.media,
      conversationSamples: context.conversationSamples,
      ...(result.generationId ? { generationId: result.generationId } : {}),
    },
    createdAt: new Date().toISOString(),
  });
  return result;
};
