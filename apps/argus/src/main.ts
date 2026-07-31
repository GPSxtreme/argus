import { resolveConfigPath } from "@argus/config";
import { startRuntime } from "./runtime.js";

const configPath = resolveConfigPath();
const runtime = await startRuntime(configPath);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void runtime.stop().finally(() => process.exit(0));
  });
}
