import type { SourceItem } from "@argus/contracts";
import {
  readBoundedBody,
  SAFE_HTTP_MAX_TIMEOUT_MS,
} from "@argus/source-web";
import { normalizeXStatus } from "./normalize.js";

const FXEMBED_MAX_BODY_BYTES = 2 * 1024 * 1024;

type Tweet = Record<string, unknown>;

const tweetsFrom = (payload: unknown): Tweet[] => {
  if (Array.isArray(payload)) return payload as Tweet[];
  if (!payload || typeof payload !== "object") return [];
  const object = payload as Record<string, unknown>;
  for (const key of ["tweets", "replies", "data", "results"]) {
    if (Array.isArray(object[key])) return object[key] as Tweet[];
  }
  return [];
};

export interface XConversationPage {
  items: SourceItem[];
  cursor?: string;
}

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

  async conversation(id: string, cursor?: string): Promise<XConversationPage> {
    const path = `/2/conversation/${encodeURIComponent(id)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
    const payload = await this.requestPayload(path);
    const root = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
    const rawCursor = root.next_cursor ?? root.cursor;
    const next =
      typeof rawCursor === "object" && rawCursor !== null
        ? (rawCursor as Record<string, unknown>).bottom
        : rawCursor;
    return {
      items: tweetsFrom(payload).map(normalizeXStatus).filter((item): item is SourceItem => item !== undefined),
      ...(typeof next === "string" && next ? { cursor: next } : {}),
    };
  }

  private async request(path: string): Promise<SourceItem[]> {
    const payload = await this.requestPayload(path);
    return tweetsFrom(payload).map(normalizeXStatus).filter((item): item is SourceItem => item !== undefined);
  }

  private async requestPayload(path: string): Promise<unknown> {
    const response = await this.fetcher(`${this.endpoint}${path}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(SAFE_HTTP_MAX_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        `FxEmbed request failed (${response.status}): ${await readBoundedBody(
          response,
          FXEMBED_MAX_BODY_BYTES,
        ).catch(() => "")}`,
      );
    }
    return JSON.parse(await readBoundedBody(response, FXEMBED_MAX_BODY_BYTES)) as unknown;
  }
}
