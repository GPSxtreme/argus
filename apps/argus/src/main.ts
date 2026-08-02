import { resolveConfigPath } from "@argus/config";
import { migrateRuntime, startRuntime } from "./runtime.js";

const configPath = resolveConfigPath();
if (process.argv.slice(2).join(" ") === "migrate") {
  await migrateRuntime(configPath);
  process.exit(0);
}
const runtime = await startRuntime(configPath);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void runtime.stop().finally(() => process.exit(0));
  });
}
