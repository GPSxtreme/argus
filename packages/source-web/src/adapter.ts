import type {
  PullInput,
  SourceAdapter,
  SourceItem,
  ValidationResult,
} from "@argus/contracts";
import { fetchFeed } from "./feed.js";
import type { SafeHttpOptions } from "./safe-http.js";
import { searchSearxng } from "./search.js";
import { fetchPage } from "./url.js";

export interface WebTargetConfig {
  kind: "url" | "feed" | "query";
  value: string;
  searchEndpoint?: string;
  userAgent?: string;
}

export class WebAdapter implements SourceAdapter<WebTargetConfig> {
  readonly kind = "web" as const;
  readonly capabilities = {
    polling: true,
    backfill: true,
    realtime: false,
  };

  constructor(private readonly httpOptions: SafeHttpOptions = {}) {}

  async validate(config: WebTargetConfig): Promise<ValidationResult> {
    const valid =
      Boolean(config.value) &&
      (config.kind === "query"
        ? Boolean(config.searchEndpoint && URL.canParse(config.searchEndpoint))
        : URL.canParse(config.value));
    return { valid, errors: valid ? [] : ["Invalid web target configuration"] };
  }

  async *pull(input: PullInput<WebTargetConfig>): AsyncIterable<SourceItem> {
    if (input.config.kind === "url") {
      yield await fetchPage(
        input.config.value,
        this.httpOptions,
        input.config.userAgent ?? "Argus/0.1",
      );
      return;
    }
    const items =
      input.config.kind === "feed"
        ? await fetchFeed(input.config.value, this.httpOptions)
        : await searchSearxng(
            input.config.searchEndpoint as string,
            input.config.value,
            this.httpOptions,
          );
    for (const item of items) yield item;
  }
}
