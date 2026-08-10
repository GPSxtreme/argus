import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { renderArgusWrapper } from "../../packages/release/src/wrapper.js";

interface ParsedArguments {
  output?: string;
}

const usage = "Usage: export-wrapper.ts [--output PATH]";

const parseArguments = (arguments_: readonly string[]): ParsedArguments => {
  let output: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument !== "--output") throw new Error(usage);
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--") || output !== undefined) {
      throw new Error(usage);
    }
    output = value;
    index += 1;
  }
  return output === undefined ? {} : { output };
};

const main = async (): Promise<void> => {
  const arguments_ = parseArguments(process.argv.slice(2));
  const wrapper = renderArgusWrapper();
  if (arguments_.output === undefined) {
    process.stdout.write(wrapper);
    return;
  }
  const output = resolve(arguments_.output);
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}`;
  await writeFile(temporary, wrapper, { mode: 0o755, flag: "wx" });
  await rename(temporary, output);
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
