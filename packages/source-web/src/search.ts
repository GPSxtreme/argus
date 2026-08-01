import type { SourceItem } from "@argus/contracts";
import { safeHttpGet, type SafeHttpOptions } from "./safe-http.js";

export const searchSearxng = async (
  endpoint: string,
  query: string,
  options: SafeHttpOptions | typeof fetch = {},
): Promise<SourceItem[]> => {
  const url = new URL("/search", endpoint);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  const response =
    typeof options === "function"
      ? await options(url, { headers: { accept: "application/json" } }).then(
          async (result) => ({
            ok: result.ok,
            status: result.status,
            body: await result.text(),
          }),
        )
      : await safeHttpGet(url, {
          ...options,
          headers: { ...options.headers, accept: "application/json" },
        });
  if (!response.ok)
    throw new Error(`SearXNG request failed (${response.status})`);
  const body = JSON.parse(response.body) as {
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
