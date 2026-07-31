import type { SourceItem } from "@argus/contracts";

type Tweet = Record<string, unknown>;

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" || typeof value === "number"
    ? String(value)
    : undefined;

const tweetsFrom = (payload: unknown): Tweet[] => {
  if (Array.isArray(payload)) return payload as Tweet[];
  if (!payload || typeof payload !== "object") return [];
  const object = payload as Record<string, unknown>;
  for (const key of ["tweets", "data", "results"]) {
    if (Array.isArray(object[key])) return object[key] as Tweet[];
  }
  return [];
};

const toItem = (tweet: Tweet): SourceItem | undefined => {
  const id = stringValue(tweet.id ?? tweet.rest_id);
  const text = stringValue(tweet.text ?? tweet.full_text);
  if (!id || !text) return undefined;
  const authorObject =
    tweet.author && typeof tweet.author === "object"
      ? (tweet.author as Record<string, unknown>)
      : {};
  const author = stringValue(
    authorObject.screen_name ??
      authorObject.username ??
      tweet.screen_name ??
      tweet.username,
  );
  return {
    externalId: id,
    url: author
      ? `https://x.com/${author}/status/${id}`
      : `https://x.com/i/status/${id}`,
    text,
    ...(author ? { author } : {}),
    ...(stringValue(tweet.created_at)
      ? { publishedAt: stringValue(tweet.created_at) as string }
      : {}),
    raw: tweet,
  };
};

export class FxEmbedClient {
  private readonly endpoint: string;

  constructor(
    endpoint: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.endpoint = endpoint.replace(/\/+$/u, "");
  }

  async account(handle: string): Promise<SourceItem[]> {
    return this.request(`/2/profile/${encodeURIComponent(handle)}/statuses`);
  }

  async search(query: string): Promise<SourceItem[]> {
    return this.request(`/2/search?query=${encodeURIComponent(query)}`);
  }

  private async request(path: string): Promise<SourceItem[]> {
    const response = await this.fetcher(`${this.endpoint}${path}`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(
        `FxEmbed request failed (${response.status}): ${await response.text()}`,
      );
    }
    return tweetsFrom((await response.json()) as unknown)
      .map(toItem)
      .filter((item): item is SourceItem => item !== undefined);
  }
}
