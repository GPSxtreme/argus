import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresRepository } from "../src/index.js";

const fakeRepository = (failJobUpdate = false) => {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      calls.push({ text, ...(values ? { values } : {}) });
      if (failJobUpdate && text.includes("UPDATE jobs")) {
        throw new Error("job update failed");
      }
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
  } as unknown as Pool;
  return {
    calls,
    client,
    repository: new PostgresRepository(pool),
  };
};

describe("PostgreSQL diagnostic transaction SQL", () => {
  it("cancels the watch and job using separate parameterized statements", async () => {
    const { calls, client, repository } = fakeRepository();

    await repository.cancelDiagnosticWatch("__argus_doctor:cancel");

    expect(calls.map(({ text }) => text.trim().split(/\s/u)[0])).toEqual([
      "BEGIN",
      "UPDATE",
      "UPDATE",
      "COMMIT",
    ]);
    expect(calls[1]?.values).toEqual(["__argus_doctor:cancel"]);
    expect(calls[2]?.values).toEqual(["__argus_doctor:cancel"]);
    expect(calls.some(({ text }) => text.includes("; UPDATE"))).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back both cancellation transitions when the job update fails", async () => {
    const { calls, client, repository } = fakeRepository(true);

    await expect(
      repository.cancelDiagnosticWatch("__argus_doctor:rollback"),
    ).rejects.toThrow("job update failed");

    expect(calls.at(-1)?.text).toBe("ROLLBACK");
    expect(calls.some(({ text }) => text === "COMMIT")).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
