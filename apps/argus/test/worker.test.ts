import { validateConfig } from "@argus/config";
import type { SourceItem } from "@argus/contracts";
import type { ScheduledTarget } from "@argus/scheduler";
import { createSqliteRepository } from "@argus/storage-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runTarget } from "../src/worker.js";

const repositories: Awaited<ReturnType<typeof createSqliteRepository>>[] = [];
afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
});

describe("target worker", () => {
  it("advances a chronological Telegram checkpoint to the newest item", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const config = validateConfig({
      version: 1,
      storage: { adapter: "sqlite", url: ":memory:" },
      sources: { telegram: { enabled: true } },
      watches: [],
    });
    const target: ScheduledTarget = {
      id: "release:telegram:channel:argus",
      source: "telegram",
      watchId: "release",
      schedule: "* * * * *",
      kind: "channel",
      value: "argus",
      keywords: [],
    };
    const items: SourceItem[] = ["41", "42"].map((id) => ({
      externalId: id,
      url: `https://t.me/argus/${id}`,
      text: `Message ${id}`,
      raw: {},
    }));
    await runTarget(target, config, repository, {
      kind: "telegram",
      capabilities: { polling: true, backfill: true, realtime: false },
      validate: async () => ({ valid: true, errors: [] }),
      pull: async function* () {
        yield* items;
      },
    });
    expect(
      await repository.getCheckpoint<{ lastId: string }>(target.id),
    ).toMatchObject({ lastId: "42" });
  });
});
