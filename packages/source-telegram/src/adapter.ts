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
  implements SourceAdapter<TelegramTargetConfig, { before?: string }>
{
  readonly kind = "telegram" as const;
  readonly capabilities = {
    polling: true,
    backfill: true,
    realtime: false,
  };

  async validate(config: TelegramTargetConfig): Promise<ValidationResult> {
    const valid = /^[A-Za-z0-9_]+$/u.test(config.channel);
    return {
      valid,
      errors: valid ? [] : ["Telegram channel must be a public username"],
    };
  }

  async *pull(
    input: PullInput<TelegramTargetConfig, { before?: string }>,
  ): AsyncIterable<SourceItem> {
    for (const item of await new TelegramPublicClient().channel(
      input.config.channel,
      input.checkpoint?.before,
    )) {
      yield item;
    }
  }
}
