#!/usr/bin/env node
import { createExecaExecutor } from "@argus/deployment";
import { loadConfig } from "@argus/config";
import { join } from "node:path";
import { CliExitError, writeFailure } from "./output.js";
import { createReleaseComposition } from "./integrations.js";
import {
  createNodeCliDependencies,
  createProgram,
} from "./program.js";
import { createClackPromptAdapter } from "./prompts.js";

const root = process.env.ARGUS_INSTALL_ROOT ?? "/opt/argus";
const executor = createExecaExecutor();
const common = {
  root,
  executor,
  prompt: createClackPromptAdapter(),
  io: {
    stdout: (value: string) => process.stdout.write(value),
    stderr: (value: string) => process.stderr.write(value),
  },
};
const bootstrap = createNodeCliDependencies(common);
const argumentsList = process.argv.slice(2);
const commandArguments = argumentsList.filter((value) => value !== "--json");
const bareCommand = commandArguments.length === 0;
const namespaceHelp =
  commandArguments.length === 1 &&
  (commandArguments[0] === "config" || commandArguments[0] === "secrets");
const informationalCommand =
  argumentsList.includes("--help") ||
  argumentsList.includes("-h") ||
  argumentsList.includes("--version") ||
  argumentsList.includes("-V") ||
  namespaceHelp ||
  (bareCommand &&
    (argumentsList.includes("--json") ||
      process.stdin.isTTY !== true ||
      process.stdout.isTTY !== true));
let dependencies = bootstrap;

try {
  if (!informationalCommand) {
    const secrets = await bootstrap.secretValues();
    const installedConfig = await loadConfig(join(root, "argus.yaml"), {
      ...process.env,
      ...secrets,
    }).catch(() => undefined);
    const composition = createReleaseComposition({
      root,
      executor,
      environment: process.env,
      ...(secrets.ARGUS_API_TOKEN === undefined
        ? {}
        : { apiToken: secrets.ARGUS_API_TOKEN }),
      ...(installedConfig === undefined
        ? {}
        : { apiPort: installedConfig.api.port }),
    });
    dependencies = createNodeCliDependencies({
      ...common,
      ...composition,
    });
  }
  await createProgram(dependencies).parseAsync(process.argv);
} catch (error) {
  if (error instanceof CliExitError) {
    process.exitCode = error.exitCode;
  } else {
    const secrets = await dependencies
      .secretValues()
      .then(Object.values)
      .catch(() => []);
    process.exitCode = writeFailure(
      dependencies.io,
      process.argv.includes("--json"),
      error,
      secrets,
    ).exitCode;
  }
}
