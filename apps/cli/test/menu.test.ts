import { describe, expect, it } from "vitest";
import { selectMenuInvocation } from "../src/menu.js";
import type { PromptAdapter } from "../src/prompts.js";

const promptQueue = (...answers: string[]): PromptAdapter => {
  const queue = [...answers];
  const next = () => {
    const answer = queue.shift();
    if (answer === undefined) throw new Error("Unexpected prompt");
    return answer;
  };
  return {
    async select() {
      return next();
    },
    async text() {
      return next();
    },
    async confirm() {
      throw new Error("Unexpected confirmation");
    },
    async multiselect() {
      throw new Error("Unexpected multiselect");
    },
    async secret() {
      throw new Error("Unexpected secret prompt");
    },
  };
};

describe("interactive home menu routing", () => {
  it.each([
    ["onboard", ["onboard"]],
    ["status", ["status"]],
    ["doctor", ["doctor"]],
    ["update", ["update"]],
  ])("maps %s to its direct command", async (selection, expected) => {
    await expect(selectMenuInvocation(promptQueue(selection))).resolves.toEqual(
      expected,
    );
  });

  it("can exit without invoking a command", async () => {
    await expect(selectMenuInvocation(promptQueue("exit"))).resolves.toBeNull();
  });

  it("collects bounded log choices", async () => {
    await expect(
      selectMenuInvocation(promptQueue("logs", "argus", "50")),
    ).resolves.toEqual(["logs", "argus", "--tail", "50"]);
    await expect(
      selectMenuInvocation(promptQueue("logs", "all", "200")),
    ).resolves.toEqual(["logs", "--tail", "200"]);
  });

  it("routes configuration, services, and secrets through direct commands", async () => {
    await expect(
      selectMenuInvocation(promptQueue("config", "show")),
    ).resolves.toEqual(["config", "show"]);
    await expect(
      selectMenuInvocation(promptQueue("services", "restart")),
    ).resolves.toEqual(["restart"]);
    await expect(
      selectMenuInvocation(
        promptQueue("secrets", "ARGUS_API_TOKEN"),
      ),
    ).resolves.toEqual(["secrets", "set", "ARGUS_API_TOKEN"]);
  });
});
