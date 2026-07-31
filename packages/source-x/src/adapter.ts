import type {
  PullInput,
  SourceAdapter,
  SourceItem,
  ValidationResult,
} from "@argus/contracts";
import { FxEmbedClient } from "./client.js";

export interface XTargetConfig {
  endpoint: string;
  kind: "account" | "query";
  value: string;
}

export class XAdapter implements SourceAdapter<XTargetConfig, { lastId?: string }> {
  readonly kind = "x" as const;
  readonly capabilities = {
    polling: true,
    backfill: true,
    realtime: false,
  };

  async validate(config: XTargetConfig): Promise<ValidationResult> {
    const valid =
      Boolean(config.value.trim()) &&
      ["account", "query"].includes(config.kind) &&
      URL.canParse(config.endpoint);
    return { valid, errors: valid ? [] : ["Invalid X target configuration"] };
  }

  async *pull(
    input: PullInput<XTargetConfig, { lastId?: string }>,
  ): AsyncIterable<SourceItem> {
    const client = new FxEmbedClient(input.config.endpoint);
    const items =
      input.config.kind === "account"
        ? await client.account(input.config.value)
        : await client.search(input.config.value);
    for (const item of items) {
      if (item.externalId === input.checkpoint?.lastId) break;
      yield item;
    }
  }
}
