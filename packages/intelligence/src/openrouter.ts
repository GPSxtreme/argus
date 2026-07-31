import type { RecordEnvelope } from "@argus/contracts";

export interface OpenRouterClientOptions {
  apiKey: string;
  model: string;
  fetcher?: typeof fetch;
  endpoint?: string;
}

export interface SourcedSummary {
  content: string;
  model: string;
  generationId?: string;
  sources: Array<{ index: number; recordId: string; url: string }>;
}

export class OpenRouterClient {
  private readonly fetcher: typeof fetch;
  private readonly endpoint: string;

  constructor(private readonly options: OpenRouterClientOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.endpoint =
      options.endpoint ?? "https://openrouter.ai/api/v1/chat/completions";
  }

  async summarize(records: RecordEnvelope[], prompt?: string): Promise<SourcedSummary> {
    const sources = records.map((record, index) => ({
      index: index + 1,
      recordId: record.id,
      url: record.url,
    }));
    const context = records
      .map(
        (record, index) =>
          `[${index + 1}] ${record.title ?? "(untitled)"}\n${record.text}\nSource: ${record.url}`,
      )
      .join("\n\n");
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/GPSxtreme/argus",
        "X-Title": "Argus",
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: [
          {
            role: "system",
            content:
              "Summarize only the supplied records. Cite factual statements using [n]. Never invent a source.",
          },
          {
            role: "user",
            content: `${prompt ?? "Give a concise, useful summary."}\n\n${context}`,
          },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`OpenRouter request failed (${response.status})`);
    }
    const body = (await response.json()) as {
      id?: string;
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenRouter returned no summary content");
    return {
      content,
      model: body.model ?? this.options.model,
      ...(body.id ? { generationId: body.id } : {}),
      sources,
    };
  }
}
