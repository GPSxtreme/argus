import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  SourceAdapter,
  SourceName,
} from "../../packages/contracts/src/index.js";
import { ingestItems } from "../../packages/engine/src/index.js";
import { QueryService } from "../../packages/query/src/index.js";
import { TelegramAdapter } from "../../packages/source-telegram/src/index.js";
import {
  createTrustedServiceOrigin,
  WebAdapter,
} from "../../packages/source-web/src/index.js";
import { XAdapter } from "../../packages/source-x/src/index.js";
import { createSqliteRepository } from "../../packages/storage-sqlite/src/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

const ingest = async (
  source: SourceName,
  targetId: string,
  adapter: SourceAdapter<never>,
  config: never,
  repository: Awaited<ReturnType<typeof createSqliteRepository>>,
) =>
  ingestItems({
    source,
    targetId,
    watchIds: [`${source}-watch`],
    keywords: ["argus"],
    items: adapter.pull({ targetId, config }),
    checkpoint: { complete: true },
    repository,
    now: () => "2026-08-02T00:00:00.000Z",
  });

describe("Trinity ingestion", () => {
  it("runs X, Telegram, and Web adapters and returns agent-digestible records with source links", async () => {
    const directory = await mkdtemp(join(tmpdir(), "argus-trinity-"));
    temporaryDirectories.push(directory);
    const repository = await createSqliteRepository({
      filename: join(directory, "argus.db"),
    });

    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://fxembed.test/2/profile/argus/statuses")) {
        return Response.json({
          tweets: [
            {
              id: "x-1",
              text: "Argus ships the data layer",
              username: "argus",
            },
          ],
        });
      }
      if (url === "https://t.me/s/argus_news") {
        return new Response(`
          <div class="tgme_widget_message" data-post="argus_news/41">
            <a class="tgme_widget_message_date" href="https://t.me/argus_news/41">
              <time datetime="2026-08-02T00:00:00+00:00"></time>
            </a>
            <div class="tgme_widget_message_text">Argus announcement</div>
          </div>
        `);
      }
      return new Response("not found", { status: 404 });
    });

    const x = new XAdapter();
    const telegram = new TelegramAdapter();
    const web = new WebAdapter({
      trustedSearchOrigin: createTrustedServiceOrigin("http://searxng:8080"),
      trustedService: {
        request: async () =>
          Response.json({
            results: [
              {
                url: "https://example.com/argus",
                title: "Argus",
                content: "Argus web result",
              },
            ],
          }),
      },
    });

    const runs = await Promise.all([
      ingest(
        "x",
        "x-account",
        x as SourceAdapter<never>,
        {
          endpoint: "https://fxembed.test",
          kind: "account",
          value: "argus",
        } as never,
        repository,
      ),
      ingest(
        "telegram",
        "telegram-channel",
        telegram as SourceAdapter<never>,
        { channel: "argus_news" } as never,
        repository,
      ),
      ingest(
        "web",
        "web-query",
        web as SourceAdapter<never>,
        { kind: "query", value: "argus" } as never,
        repository,
      ),
    ]);

    expect(runs).toEqual([
      { inserted: 1, revised: 0, duplicates: 0 },
      { inserted: 1, revised: 0, duplicates: 0 },
      { inserted: 1, revised: 0, duplicates: 0 },
    ]);

    const result = await new QueryService(repository).search({ limit: 100 });
    expect(result.summary).toBe("3 records");
    expect(new Set(result.items.map((record) => record.source))).toEqual(
      new Set(["x", "telegram", "web"]),
    );
    expect(
      result.items.every(
        (record) => record.raw !== undefined && URL.canParse(record.url),
      ),
    ).toBe(true);

    repository.close();
  });
});
