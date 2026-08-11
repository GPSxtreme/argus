import { setTimeout } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createExecaExecutor } from "../src/index.js";

describe("Execa command executor", () => {
  it("cancels a running child process when its signal aborts", async () => {
    const controller = new AbortController();
    const operation = createExecaExecutor().run(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1_000)"],
      { signal: controller.signal },
    );

    await setTimeout(20);
    controller.abort();

    await expect(operation).resolves.toMatchObject({ exitCode: 1 });
  });
});
