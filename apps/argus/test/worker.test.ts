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

  it("does not commit a diagnostic target cancelled while its adapter is in flight", async () => {
    const repository = await createSqliteRepository({ filename: ":memory:" });
    repositories.push(repository);
    const config = validateConfig({ version: 1, storage: { adapter: "sqlite", url: ":memory:" }, sources: { web: { enabled: true } }, watches: [] });
    let active = true;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const running = runTarget({ id: "__argus_doctor:test", source: "web", watchId: "__argus_doctor:test", schedule: "* * * * *", kind: "url", value: "https://example.com", keywords: [] }, config, repository, { kind: "web", capabilities: { polling: true, backfill: true, realtime: false }, validate: async () => ({ valid: true, errors: [] }), pull: async function* () { await barrier; yield { externalId: "one", url: "https://example.com", text: "diagnostic", raw: {} }; } }, async () => active);
    active = false;
    release();
    expect(await running).toEqual({ inserted: 0, revised: 0, duplicates: 0 });
    expect((await repository.queryRecords({ targetIds: ["__argus_doctor:test"] })).items).toEqual([]);
  });
});
