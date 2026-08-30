import { describe, expect, it } from "vitest";
import {
  DeploymentError,
  deploymentErrorSchema,
  onboardingAnswersSchema,
} from "../src/index.js";

describe("deployment contracts", () => {
  it("runs X on the VPS without requiring Cloudflare credentials", () => {
    expect(
      onboardingAnswersSchema.parse({
        version: 2,
        deployment: {
          provider: "vps-docker",
          root: "/opt/argus",
          storage: "sqlite",
          apiHost: "0.0.0.0",
          apiPort: 8788,
        },
        managed: { searxng: "disabled", fxembed: "vps" },
        xReplies: { enabled: false, maxPerPost: 50, maxTrackingHours: 168, orderBy: "likes" },
        watches: [],
        intelligence: { enabled: false, model: "openai/gpt-4.1-mini" },
      }),
    ).toMatchObject({ managed: { fxembed: "vps" } });
  });

  it("rejects Cloudflare-hosted X without a Cloudflare account id", () => {
    expect(() =>
      onboardingAnswersSchema.parse({
        version: 2,
        deployment: {
          provider: "vps-docker",
          root: "/opt/argus",
          storage: "sqlite",
          apiHost: "0.0.0.0",
          apiPort: 8788,
        },
        managed: { searxng: "disabled", fxembed: "cloudflare" },
        xReplies: { enabled: false, maxPerPost: 50, maxTrackingHours: 168, orderBy: "likes" },
        cloudflare: {},
        watches: [],
        intelligence: { enabled: false, model: "openai/gpt-4.1-mini" },
      }),
    ).toThrow();
  });

  it("rejects the obsolete managed FxEmbed mode", () => {
    expect(() =>
      onboardingAnswersSchema.parse({
        version: 2,
        deployment: {
          provider: "vps-docker",
          root: "/opt/argus",
          storage: "sqlite",
          apiHost: "0.0.0.0",
          apiPort: 8788,
        },
        managed: { searxng: "disabled", fxembed: "managed" },
        xReplies: { enabled: false, maxPerPost: 50, maxTrackingHours: 168, orderBy: "likes" },
        watches: [],
        intelligence: { enabled: false, model: "openai/gpt-4.1-mini" },
      }),
    ).toThrow();
  });

  it("serializes deployment errors without secret causes", () => {
    const error = new DeploymentError("CF_DEPLOY_FAILED", "token secret-token failed", {
      secrets: ["secret-token"],
      recovery: "argus repair fxembed --token secret-token",
    });
    expect(error.toJSON()).toEqual({
      code: "CF_DEPLOY_FAILED",
      message: "token [REDACTED] failed",
      recovery: "argus repair fxembed --token [REDACTED]",
    });
    expect(JSON.stringify(error.toJSON())).not.toContain("secret-token");
  });

  it("requires endpoints for external managed services", () => {
    const answers = {
      version: 2,
      deployment: {
        provider: "vps-docker",
        root: "/opt/argus",
        storage: "sqlite",
        apiHost: "0.0.0.0",
        apiPort: 8788,
      },
      managed: { searxng: "external", fxembed: "external" },
      xReplies: { enabled: false, maxPerPost: 50, maxTrackingHours: 168, orderBy: "likes" },
      watches: [],
      intelligence: { enabled: false, model: "openai/gpt-4.1-mini" },
    };

    expect(() => onboardingAnswersSchema.parse(answers)).toThrow();
    expect(
      onboardingAnswersSchema.parse({
        ...answers,
        external: {
          searxngEndpoint: "https://searxng.example.com",
          fxembedEndpoint: "https://fxembed.example.com",
        },
      }),
    ).toMatchObject({ managed: answers.managed });
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
