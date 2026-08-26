import { DeploymentError } from "@argus/deployment";
import { describe, expect, it } from "vitest";
import { writeFailure } from "../src/output.js";

const harness = () => {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout(value: string) {
        stdout += value;
      },
      stderr(value: string) {
        stderr += value;
      },
    },
    output: () => ({ stdout, stderr }),
  };
};

describe("CLI failure output", () => {
  it("uses plain, actionable labels for people", () => {
    const test = harness();

    writeFailure(
      test.io,
      false,
      new DeploymentError("SERVICE_DOWN", "Argus is not running.", {
        recovery: "Run 'argus repair argus'.",
      }),
    );

    expect(test.output()).toEqual({
      stdout: "",
      stderr:
        "Error: Argus is not running.\nTry: Run 'argus repair argus'.\nCode: SERVICE_DOWN\n",
    });
  });

  it("keeps the stable machine contract unchanged", () => {
    const test = harness();

    writeFailure(
      test.io,
      true,
      new DeploymentError("SERVICE_DOWN", "Argus is not running.", {
        recovery: "Repair it.",
      }),
    );

    expect(JSON.parse(test.output().stdout)).toEqual({
      contractVersion: 1,
      ok: false,
      error: {
        code: "SERVICE_DOWN",
        message: "Argus is not running.",
        recovery: "Repair it.",
      },
    });
    expect(test.output().stderr).toBe("");
  });

  it("adds safe human guidance without changing JSON errors", () => {
    const test = harness();

    writeFailure(
      test.io,
      false,
      new DeploymentError(
        "LOG_TAIL_INVALID",
        "Log tail must be a positive integer no greater than 10000.",
      ),
    );

    expect(test.output().stderr).toBe(
      "Error: Log tail must be a positive integer no greater than 10000.\n" +
        "Try: Run 'argus logs --tail 200'.\n" +
        "Code: LOG_TAIL_INVALID\n",
    );
  });
});
