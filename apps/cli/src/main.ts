#!/usr/bin/env node
import { openRepository, startRuntime } from "@argus/app";
import {
  loadConfig,
  reconcileConfig,
  resolveConfigPath,
} from "@argus/config";
import { Command } from "commander";

const program = new Command()
  .name("argus")
  .description("Self-hosted data layer for X, Telegram, and the Web")
  .version("0.1.0");

const config = program.command("config").description("Manage Argus configuration");

config
  .command("validate")
  .argument("[path]", "configuration path")
  .action(async (path?: string) => {
    const loaded = await loadConfig(
      resolveConfigPath(path ? { explicitPath: path } : {}),
    );
    process.stdout.write(
      `${JSON.stringify({
        valid: true,
        version: loaded.version,
        watches: loaded.watches.length,
        role: loaded.runtime.role,
      })}\n`,
    );
  });

config
  .command("apply")
  .argument("[path]", "configuration path")
  .action(async (path?: string) => {
    const loaded = await loadConfig(
      resolveConfigPath(path ? { explicitPath: path } : {}),
    );
    const handle = await openRepository(loaded);
    try {
      const result = await reconcileConfig(handle.repository, loaded);
      process.stdout.write(`${JSON.stringify({ applied: true, ...result })}\n`);
    } finally {
      await handle.close();
    }
  });

program
  .command("run")
  .argument("[path]", "configuration path")
  .description("Start the configured Argus runtime role")
  .action(async (path?: string) => {
    await startRuntime(resolveConfigPath(path ? { explicitPath: path } : {}));
  });

await program.parseAsync(process.argv);
