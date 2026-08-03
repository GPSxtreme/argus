import type { SourceItem } from "@argus/contracts";
import {
  readBoundedBody,
  SAFE_HTTP_MAX_TIMEOUT_MS,
} from "@argus/source-web";
import { parseTelegramPreview } from "./parse.js";

const TELEGRAM_MAX_BODY_BYTES = 2 * 1024 * 1024;

export class TelegramPublicClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async channel(channel: string, before?: string): Promise<SourceItem[]> {
    const url = new URL(`https://t.me/s/${encodeURIComponent(channel)}`);
    if (before) url.searchParams.set("before", before);
    const response = await this.fetcher(url, {
      headers: { "user-agent": "Argus/0.1 (+public-channel-monitor)" },
      signal: AbortSignal.timeout(SAFE_HTTP_MAX_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Telegram preview failed (${response.status})`);
    }
    return parseTelegramPreview(
      await readBoundedBody(response, TELEGRAM_MAX_BODY_BYTES),
      channel,
    );
  }
}
