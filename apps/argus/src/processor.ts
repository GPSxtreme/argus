import { randomUUID } from "node:crypto";
import type { ArgusConfig } from "@argus/config";
import type { RecordEnvelope, StorageRepository } from "@argus/contracts";
import {
  OpenRouterClient,
  type SourcedSummary,
} from "@argus/intelligence";

type Processor = ArgusConfig["intelligence"]["processors"][number];
interface SummaryClient {
  summarize(records: RecordEnvelope[], prompt?: string): Promise<SourcedSummary>;
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
  const result = await client.summarize(records.items, processor.prompt);
  await repository.saveArtifact({
    id: randomUUID(),
    recordIds: records.items.map((record) => record.id),
    kind: "summary",
    content: result.content,
    provider: "openrouter",
    model: result.model,
    provenance: {
      processorId: processor.id,
      sources: result.sources,
      ...(result.generationId ? { generationId: result.generationId } : {}),
    },
    createdAt: new Date().toISOString(),
  });
  return result;
};
