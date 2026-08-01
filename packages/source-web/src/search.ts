import type { SourceItem } from "@argus/contracts";
import {
  requestTrustedSearch,
  type TrustedServiceOrigin,
  type TrustedServiceRequestOptions,
} from "./trusted-service.js";

export const searchSearxng = async (
  origin: TrustedServiceOrigin,
  query: string,
  options: TrustedServiceRequestOptions = {},
): Promise<SourceItem[]> => {
  const response = await requestTrustedSearch(origin, query, options);
  if (!response.ok)
    throw new Error(`SearXNG request failed (${response.status})`);
  let body: {
    results?: Array<{ url?: string; title?: string; content?: string }>;
  };
  try {
    body = JSON.parse(response.body) as typeof body;
  } catch {
    throw new Error("SearXNG returned an invalid response");
  }
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
