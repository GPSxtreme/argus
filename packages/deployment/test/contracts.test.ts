import { describe, expect, it } from "vitest";
import {
  DeploymentError,
  deploymentErrorSchema,
  onboardingAnswersSchema,
} from "../src/index.js";

describe("deployment contracts", () => {
  it("rejects managed X without a Cloudflare account id", () => {
    expect(() =>
      onboardingAnswersSchema.parse({
        version: 1,
        deployment: {
          provider: "vps-docker",
          root: "/opt/argus",
          storage: "sqlite",
          apiHost: "0.0.0.0",
          apiPort: 8788,
        },
        managed: { searxng: "disabled", fxembed: "managed" },
        cloudflare: {},
        watches: [],
        intelligence: { enabled: false, model: "openai/gpt-4.1-mini" },
      }),
    ).toThrow();
  });

  it("serializes deployment errors without secret causes", () => {
    const error = new DeploymentError("CF_DEPLOY_FAILED", "token secret-token failed", {
      secrets: ["secret-token"],
      recovery: "argus repair fxembed",
    });
    expect(error.toJSON()).toEqual({
      code: "CF_DEPLOY_FAILED",
      message: "token [REDACTED] failed",
      recovery: "argus repair fxembed",
    });
  });

  it("validates the public deployment error shape", () => {
    expect(
      deploymentErrorSchema.parse({
        code: "CF_DEPLOY_FAILED",
        message: "Cloudflare deployment failed",
        recovery: "argus repair fxembed",
      }),
    ).toEqual({
      code: "CF_DEPLOY_FAILED",
      message: "Cloudflare deployment failed",
      recovery: "argus repair fxembed",
    });
  });
});
