import { readBoundedBody, SAFE_HTTP_MAX_TIMEOUT_MS } from "@argus/source-web";

export type InputModality = "text" | "image" | "video" | "audio" | "file";
export interface ModelCapabilities {
  input: Set<InputModality>;
  source: "openrouter" | "fallback";
  reason?: string;
}

const KNOWN_MODALITIES = new Set<InputModality>([
  "text",
  "image",
  "video",
  "audio",
  "file",
]);
const cache = new Map<string, { expiresAt: number; value: ModelCapabilities }>();

export class OpenRouterCapabilitiesClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async get(model: string): Promise<ModelCapabilities> {
    const cached = cache.get(model);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    try {
      const slug = model.split("/").map(encodeURIComponent).join("/");
      const response = await this.fetcher(
        `https://openrouter.ai/api/v1/model/${slug}`,
        {
          headers: { Authorization: `Bearer ${this.apiKey}` },
          signal: AbortSignal.timeout(SAFE_HTTP_MAX_TIMEOUT_MS),
        },
      );
      if (!response.ok) throw new Error(`status ${response.status}`);
      const payload = JSON.parse(await readBoundedBody(response, 2 * 1024 * 1024)) as {
        data?: { architecture?: { input_modalities?: unknown } };
      };
      const values = payload.data?.architecture?.input_modalities;
      if (!Array.isArray(values)) throw new Error("modalities unavailable");
      const input = new Set(
        values.filter(
          (value): value is InputModality =>
            typeof value === "string" &&
            KNOWN_MODALITIES.has(value as InputModality),
        ),
      );
      input.add("text");
      const value: ModelCapabilities = { input, source: "openrouter" };
      cache.set(model, { value, expiresAt: Date.now() + 60 * 60 * 1000 });
      return value;
    } catch (error) {
      return {
        input: new Set(["text"]),
        source: "fallback",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
