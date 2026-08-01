import type {
  IngestionCommitResult,
  SourceItem,
  SourceName,
  StorageRepository,
} from "@argus/contracts";
import { classify } from "./classify.js";
import { normalizeItem } from "./normalize.js";

export interface IngestItemsInput {
  source: SourceName;
  targetId: string;
  watchIds: string[];
  keywords: string[];
  items: AsyncIterable<SourceItem>;
  checkpoint: unknown;
  repository: StorageRepository;
  diagnosticJobId?: string;
  now?: () => string;
}

export const ingestItems = async (
  input: IngestItemsInput,
): Promise<IngestionCommitResult> => {
  const records = [];
  for await (const item of input.items) {
    const matchedKeywords = classify(item, input.keywords);
    records.push(
      normalizeItem({
        source: input.source,
        targetId: input.targetId,
        watchIds: input.watchIds,
        item: {
          ...item,
          metadata: {
            ...item.metadata,
            matchedKeywords,
          },
        },
        ...(input.now ? { now: input.now() } : {}),
      }),
    );
  }
  const commit = {
    records,
    targetId: input.targetId,
    checkpoint: input.checkpoint,
  };
  if (input.diagnosticJobId) {
    return (
      (await input.repository.commitDiagnosticIngestion({
        ...commit,
        jobId: input.diagnosticJobId,
      })) ?? { inserted: 0, revised: 0, duplicates: 0 }
    );
  }
  return input.repository.commitIngestion(commit);
};
