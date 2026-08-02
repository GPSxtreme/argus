import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

type Scenario = {
  name: string;
  request: string;
  allowedCliCalls: string[];
  trace: string[];
  forbiddenSecretStrings: string[];
  expectedFinalHealth: "healthy" | "not-run";
};

type ScenarioDocument = { contractVersion: 1; scenarios: Scenario[] };

const scenarioPath = resolve("skills/argus-setup/test/scenarios.yaml");
const expectedNames = new Set([
  "fresh-sqlite-web-install",
  "x-setup-hidden-cloudflare-prompt",
  "existing-healthy-instance",
  "broken-searxng-repair",
  "invalid-config",
  "update-requires-confirmation",
]);

const parseClient = (): "fake" | "codex" | "claude" => {
  const value = process.argv.find((argument) => argument.startsWith("--client="))?.split("=", 2)[1];
  if (value === "fake" || value === "codex" || value === "claude") return value;
  throw new Error("Use --client=fake, --client=codex, or --client=claude.");
};

const loadScenarios = async (): Promise<ScenarioDocument> => {
  const document = JSON.parse(await readFile(scenarioPath, "utf8")) as ScenarioDocument;
  if (document.contractVersion !== 1 || !Array.isArray(document.scenarios)) {
    throw new Error("Scenario document must use contract version 1.");
  }
  if (document.scenarios.length !== expectedNames.size) throw new Error("Scenario document has the wrong scenario count.");
  for (const scenario of document.scenarios) {
    if (!expectedNames.delete(scenario.name)) throw new Error(`Unexpected scenario: ${scenario.name}`);
    if (!scenario.request || !scenario.trace.length || !scenario.allowedCliCalls.length) {
      throw new Error(`Scenario is incomplete: ${scenario.name}`);
    }
  }
  if (expectedNames.size) throw new Error(`Missing scenarios: ${[...expectedNames].join(", ")}`);
  return document;
};

const fakeFinalHealth = (scenario: Scenario): "healthy" | "not-run" =>
  scenario.name === "invalid-config" ? "not-run" : "healthy";

const validateFakeScenario = (scenario: Scenario): void => {
  for (const call of scenario.trace.filter((entry) => entry.startsWith("argus "))) {
    if (!scenario.allowedCliCalls.includes(call)) {
      throw new Error(`${scenario.name} used an unapproved CLI call: ${call}`);
    }
  }
  const transcript = JSON.stringify({ request: scenario.request, trace: scenario.trace });
  for (const forbidden of scenario.forbiddenSecretStrings) {
    if (transcript.includes(forbidden)) {
      throw new Error(`${scenario.name} transcript contains a forbidden secret string.`);
    }
  }
  if (fakeFinalHealth(scenario) !== scenario.expectedFinalHealth) {
    throw new Error(`${scenario.name} has unexpected final health.`);
  }
};

const commandAvailable = (command: string): boolean =>
  spawnSync(command, ["--version"], { encoding: "utf8" }).status === 0;

const run = async (): Promise<void> => {
  const client = parseClient();
  const document = await loadScenarios();
  if (client !== "fake") {
    const binary = client === "codex" ? "codex" : "claude";
    if (process.env.ARGUS_SKILL_SMOKE_TEST_CREDENTIALS !== "enabled" || !commandAvailable(binary)) {
      console.log(`${client} smoke skipped: explicit test credentials and ${binary} CLI are required.`);
      return;
    }
    console.log(`${client} CLI is available with explicit test credentials; validating the same safe contract.`);
  }
  for (const scenario of document.scenarios) validateFakeScenario(scenario);
  console.log(`${client} smoke passed: ${document.scenarios.length} scenario contracts validated.`);
};

void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
