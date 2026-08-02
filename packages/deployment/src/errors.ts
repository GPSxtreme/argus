import type { DeploymentErrorJSON } from "./contracts.js";
import { z } from "zod";

export const deploymentErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string(),
    recovery: z.string().min(1).optional(),
  })
  .strict();

export interface DeploymentErrorOptions {
  secrets?: string[];
  recovery?: string;
}

const redact = (value: string, secrets: readonly string[]): string =>
  [...secrets]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce((redacted, secret) => redacted.split(secret).join("[REDACTED]"), value);

export class DeploymentError extends Error {
  readonly code: string;
  readonly recovery: string | undefined;

  constructor(code: string, message: string, options: DeploymentErrorOptions = {}) {
    const secrets = options.secrets ?? [];
    super(redact(message, secrets));
    this.name = "DeploymentError";
    this.code = code;
    this.recovery =
      options.recovery === undefined ? undefined : redact(options.recovery, secrets);
  }

  toJSON(): DeploymentErrorJSON {
    return {
      code: this.code,
      message: this.message,
      ...(this.recovery === undefined ? {} : { recovery: this.recovery }),
    };
  }
}
