import type {
  PullInput,
  SourceAdapter,
  SourceItem,
  ValidationResult,
} from "@argus/contracts";
import { fetchFeed } from "./feed.js";
import type { SafeHttpOptions } from "./safe-http.js";
import { searchSearxng } from "./search.js";
import type {
  TrustedServiceOrigin,
  TrustedServiceRequestOptions,
} from "./trusted-service.js";
import { fetchPage } from "./url.js";

export interface WebTargetConfig {
  kind: "url" | "feed" | "query";
  value: string;
  userAgent?: string;
}

export interface WebAdapterOptions extends SafeHttpOptions {
  trustedSearchOrigin?: TrustedServiceOrigin;
  trustedService?: TrustedServiceRequestOptions;
}

export class WebAdapter implements SourceAdapter<WebTargetConfig> {
  readonly kind = "web" as const;
  readonly capabilities = {
    polling: true,
    backfill: true,
    realtime: false,
  };

  constructor(private readonly options: WebAdapterOptions = {}) {}

  async validate(config: WebTargetConfig): Promise<ValidationResult> {
    const valid =
      Boolean(config.value) &&
      (config.kind === "query"
        ? Boolean(this.options.trustedSearchOrigin)
        : URL.canParse(config.value));
    return { valid, errors: valid ? [] : ["Invalid web target configuration"] };
  }

  async *pull(input: PullInput<WebTargetConfig>): AsyncIterable<SourceItem> {
    if (input.config.kind === "url") {
      yield await fetchPage(
        input.config.value,
        this.options,
        input.config.userAgent ?? "Argus/0.1",
      );
      return;
    }
    const items =
      input.config.kind === "feed"
        ? await fetchFeed(input.config.value, this.options)
        : await searchSearxng(
            this.options.trustedSearchOrigin as TrustedServiceOrigin,
            input.config.value,
            this.options.trustedService,
          );
    for (const item of items) yield item;
  }
}
