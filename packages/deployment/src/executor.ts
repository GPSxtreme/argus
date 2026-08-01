import { execa } from "execa";
import type { CommandResult } from "./contracts.js";

export interface CommandExecutor {
  run(
    command: string,
    args: string[],
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      stdin?: string;
    },
  ): Promise<CommandResult>;
}

export const createExecaExecutor = (): CommandExecutor => ({
  async run(command, args, options) {
    const result = await execa(command, args, {
      reject: false,
      ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options?.env === undefined ? {} : { env: options.env }),
      ...(options?.stdin === undefined ? {} : { input: options.stdin }),
    });

    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  },
});
