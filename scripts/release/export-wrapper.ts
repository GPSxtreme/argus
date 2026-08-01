import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { renderArgusWrapper } from "../../packages/release/src/wrapper.js";

const fixture = {
  version: "0.1.0",
  cliImageDigest: `ghcr.io/gpsxtreme/argus-cli@sha256:${"0".repeat(64)}`,
} as const;

interface ParsedArguments {
  version: string;
  cliImageDigest: string;
  output?: string;
}

const usage =
  "Usage: export-wrapper.ts --fixture [--output PATH] | --version VERSION --cli-image IMAGE@DIGEST [--output PATH]";

const parseArguments = (arguments_: readonly string[]): ParsedArguments => {
  let version: string | undefined;
  let cliImageDigest: string | undefined;
  let output: string | undefined;
  let fixtureMode = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--fixture") {
      if (fixtureMode) throw new Error(usage);
      fixtureMode = true;
      continue;
    }
    if (
      argument === "--version" ||
      argument === "--cli-image" ||
      argument === "--output"
    ) {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(usage);
      index += 1;
      if (argument === "--version") {
        if (version !== undefined) throw new Error(usage);
        version = value;
      }
      if (argument === "--cli-image") {
        if (cliImageDigest !== undefined) throw new Error(usage);
        cliImageDigest = value;
      }
      if (argument === "--output") {
        if (output !== undefined) throw new Error(usage);
        output = value;
      }
      continue;
    }
    throw new Error(usage);
  }
  if (fixtureMode) {
    if (version !== undefined || cliImageDigest !== undefined) {
      throw new Error(usage);
    }
    return { ...fixture, ...(output === undefined ? {} : { output }) };
  }
  if (version === undefined || cliImageDigest === undefined) {
    throw new Error(usage);
  }
  return { version, cliImageDigest, ...(output === undefined ? {} : { output }) };
};

const main = async (): Promise<void> => {
  const arguments_ = parseArguments(process.argv.slice(2));
  const wrapper = renderArgusWrapper(arguments_);
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
