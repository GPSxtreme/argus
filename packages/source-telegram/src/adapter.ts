import type {
  PullInput,
  SourceAdapter,
  SourceItem,
  ValidationResult,
} from "@argus/contracts";
import { TelegramPublicClient } from "./client.js";

export interface TelegramTargetConfig {
  channel: string;
}

export class TelegramAdapter
  implements SourceAdapter<TelegramTargetConfig, { lastId?: string }>
{
  readonly kind = "telegram" as const;
  readonly capabilities = {
    polling: true,
    backfill: true,
    realtime: false,
  };

  constructor(
    private readonly client: Pick<TelegramPublicClient, "channel"> =
      new TelegramPublicClient(),
  ) {}

  async validate(config: TelegramTargetConfig): Promise<ValidationResult> {
    const valid = /^[A-Za-z0-9_]+$/u.test(config.channel);
    return {
      valid,
      errors: valid ? [] : ["Telegram channel must be a public username"],
    };
  }

  async *pull(
    input: PullInput<TelegramTargetConfig, { lastId?: string }>,
  ): AsyncIterable<SourceItem> {
    const items = await this.client.channel(input.config.channel);
    const checkpointIndex = input.checkpoint?.lastId
      ? items.findIndex((item) => item.externalId === input.checkpoint?.lastId)
      : -1;
    for (const item of items.slice(checkpointIndex + 1)) {
      yield item;
    }
  }
}
