#!/usr/bin/env node
import { resolve } from "node:path";
import { openRepository, startRuntime } from "@argus/app";
import { loadConfig, reconcileConfig } from "@argus/config";
import { Command } from "commander";

const program = new Command()
  .name("argus")
  .description("Self-hosted data layer for X, Telegram, and the Web")
  .version("0.1.0");

const config = program.command("config").description("Manage Argus configuration");

config
  .command("validate")
  .argument("[path]", "configuration path", "argus.config.yaml")
  .action(async (path: string) => {
    const loaded = await loadConfig(resolve(path));
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
  .argument("[path]", "configuration path", "argus.config.yaml")
  .action(async (path: string) => {
    const loaded = await loadConfig(resolve(path));
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
  .argument("[path]", "configuration path", "argus.config.yaml")
  .description("Start the configured Argus runtime role")
  .action(async (path: string) => {
    await startRuntime(resolve(path));
  });

await program.parseAsync(process.argv);
