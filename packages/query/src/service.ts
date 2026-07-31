import type {
  Page,
  QueryRecordsInput,
  RecordEnvelope,
  StorageRepository,
} from "@argus/contracts";

export interface QueryResult extends Page<RecordEnvelope> {
  summary: string;
}

export class QueryService {
  constructor(private readonly repository: StorageRepository) {}

  async search(input: QueryRecordsInput): Promise<QueryResult> {
    const page = await this.repository.queryRecords(input);
    return {
      ...page,
      summary: `${page.items.length} ${page.items.length === 1 ? "record" : "records"}`,
    };
  }
}
