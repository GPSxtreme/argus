import type { SourceItem } from "@argus/contracts";
import { parseTelegramPreview } from "./parse.js";

export class TelegramPublicClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async channel(channel: string, before?: string): Promise<SourceItem[]> {
    const url = new URL(`https://t.me/s/${encodeURIComponent(channel)}`);
    if (before) url.searchParams.set("before", before);
    const response = await this.fetcher(url, {
      headers: { "user-agent": "Argus/0.1 (+public-channel-monitor)" },
    });
    if (!response.ok) {
      throw new Error(`Telegram preview failed (${response.status})`);
    }
    return parseTelegramPreview(await response.text(), channel);
  }
}
