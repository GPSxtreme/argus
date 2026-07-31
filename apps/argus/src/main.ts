import { resolve } from "node:path";
import { startRuntime } from "./runtime.js";

const configPath = resolve(process.env.ARGUS_CONFIG ?? "argus.config.yaml");
const runtime = await startRuntime(configPath);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void runtime.stop().finally(() => process.exit(0));
  });
}
