#!/usr/bin/env node
import { createExecaExecutor } from "@argus/deployment";
import { CliExitError, writeFailure } from "./output.js";
import {
  createNodeCliDependencies,
  createProgram,
} from "./program.js";
import { createClackPromptAdapter } from "./prompts.js";

const dependencies = createNodeCliDependencies({
  root: process.env.ARGUS_INSTALL_ROOT ?? "/opt/argus",
  executor: createExecaExecutor(),
  prompt: createClackPromptAdapter(),
  io: {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  },
});
const program = createProgram(dependencies);

try {
  await program.parseAsync(process.argv);
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
