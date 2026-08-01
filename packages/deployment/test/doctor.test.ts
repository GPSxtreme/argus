import { describe, expect, it } from "vitest";
import { runDoctor, type DoctorArgusApi, type DoctorContext } from "../src/index.js";

const result = (exitCode = 0) => ({ exitCode, stdout: "private output", stderr: "secret-token" });

const context = (overrides: Partial<DoctorContext> = {}): DoctorContext => ({
  root: "/opt/argus",
  executor: { run: async () => result() },
  api: {
    health: async () => true,
    createSmokeWatch: async ({ source }) => ({
      id: `doctor-${source}`,
      targetId: `doctor-${source}-target`,
      expectedUrl: "https://example.test/article",
    }),
    pollRecords: async () => [{ url: "https://example.test/article#fragment" }],
    removeSmokeWatch: async () => undefined,
  } satisfies DoctorArgusApi,
  storage: "sqlite",
  managed: { searxng: "disabled", fxembed: "disabled" },
  sources: { web: true, telegram: false, x: false },
  ...overrides,
});

describe("deployment doctor", () => {
  it("runs independent checks and skips disabled components", async () => {
    const report = await runDoctor(context());

    expect(report.healthy).toBe(true);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ component: "docker", status: "healthy" }),
        expect.objectContaining({ component: "argus", status: "healthy" }),
        expect.objectContaining({ component: "storage", status: "healthy" }),
        expect.objectContaining({ component: "web", status: "healthy" }),
        expect.objectContaining({ component: "searxng", status: "skipped" }),
        expect.objectContaining({ component: "fxembed", status: "skipped" }),
        expect.objectContaining({ component: "telegram", status: "skipped" }),
        expect.objectContaining({ component: "x", status: "skipped" }),
      ]),
    );
  });

  it("reports safe recovery information for a failed component", async () => {
    const report = await runDoctor(
      context({ executor: { run: async () => result(1) } }),
    );
    const docker = report.checks.find((check) => check.component === "docker");

    expect(docker).toEqual({
      component: "docker",
      status: "unhealthy",
      code: "DOCKER_UNAVAILABLE",
      message: "Docker is not available to the Argus management container.",
      recovery: "Verify Docker is running, then run argus repair argus.",
      logsCommand: "docker info",
    });
    expect(JSON.stringify(report)).not.toContain("secret-token");
    expect(JSON.stringify(report)).not.toContain("private output");
  });

  it("reports smoke cleanup failures separately without deleting user data", async () => {
    const report = await runDoctor(
      context({
        api: {
          ...context().api,
          removeSmokeWatch: async () => {
            throw new Error("secret-token");
          },
        },
      }),
    );

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        component: "web",
        status: "unhealthy",
        code: "SOURCE_SMOKE_CLEANUP_FAILED",
        recovery: "Run argus repair web to remove the dedicated diagnostic watch.",
      }),
    );
    expect(JSON.stringify(report)).not.toContain("secret-token");
  });
});
