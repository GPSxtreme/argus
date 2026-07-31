import type { SourceItem } from "@argus/contracts";

export const searchSearxng = async (
  endpoint: string,
  query: string,
  fetcher: typeof fetch = fetch,
): Promise<SourceItem[]> => {
  const url = new URL("/search", endpoint);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  const response = await fetcher(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`SearXNG request failed (${response.status})`);
  const body = (await response.json()) as {
    results?: Array<{ url?: string; title?: string; content?: string }>;
  };
  return (body.results ?? [])
    .filter((result): result is typeof result & { url: string } =>
      Boolean(result.url),
    )
    .map((result) => ({
      externalId: result.url,
      url: result.url,
      ...(result.title ? { title: result.title } : {}),
      text: result.content ?? "",
      raw: result,
    }));
};
