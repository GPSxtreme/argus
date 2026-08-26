import {
  DeploymentError,
  type DeploymentErrorJSON,
} from "@argus/deployment";

export interface CliIO {
  stdout(value: string): void;
  stderr(value: string): void;
}

export interface JsonSuccessEnvelope {
  contractVersion: 1;
  ok: true;
  data: unknown;
}

export interface JsonErrorEnvelope {
  contractVersion: 1;
  ok: false;
  error: DeploymentErrorJSON;
}

export class CliExitError extends Error {
  readonly exitCode: number;

  constructor(exitCode: number) {
    super(`Argus CLI exited with code ${exitCode}.`);
    this.name = "CliExitError";
    this.exitCode = exitCode;
  }
}

export const replaceSecrets = (
  value: string,
  secrets: readonly string[],
): string =>
  [...secrets]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce(
      (redacted, secret) => redacted.split(secret).join("[REDACTED]"),
      value,
    );

export const redactValue = (
  value: unknown,
  secrets: readonly string[],
): unknown => {
  if (typeof value === "string") return replaceSecrets(value, secrets);
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, secrets));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactValue(entry, secrets),
      ]),
    );
  }
  return value;
};

export const writeSuccess = (
  io: CliIO,
  json: boolean,
  data: unknown,
  humanMessage: string,
): void => {
  if (json) {
    const envelope: JsonSuccessEnvelope = {
      contractVersion: 1,
      ok: true,
      data,
    };
    io.stdout(`${JSON.stringify(envelope)}\n`);
    return;
  }
  io.stdout(`${humanMessage}\n`);
};

const stableError = (
  error: unknown,
  secrets: readonly string[],
): DeploymentErrorJSON => {
  if (error instanceof DeploymentError) {
    const serialized = error.toJSON();
    return {
      code: serialized.code,
      message: replaceSecrets(serialized.message, secrets),
      ...(serialized.recovery === undefined
        ? {}
        : { recovery: replaceSecrets(serialized.recovery, secrets) }),
    };
  }
  return {
    code: "COMMAND_FAILED",
    message: "The Argus command failed.",
    recovery: "Retry the command or run 'argus doctor' for safe diagnostics.",
  };
};

const humanRecovery = (error: DeploymentErrorJSON): string | undefined => {
  if (error.code === "PROMPT_CANCELLED") {
    return "Run the command again when ready.";
  }
  if (error.recovery) return error.recovery;
  switch (error.code) {
    case "LOG_TAIL_INVALID":
    case "LOG_SERVICE_INVALID":
      return "Run 'argus logs --tail 200'.";
    case "REPAIR_SERVICE_INVALID":
      return "Run 'argus repair argus --dry-run'.";
    default:
      return undefined;
  }
};

const humanMessage = (error: DeploymentErrorJSON): string =>
  error.code === "PROMPT_CANCELLED" ? "Argus was cancelled." : error.message;

export const errorExitCode = (error: unknown): number => {
  if (
    error instanceof DeploymentError &&
    error.code === "CONFIRMATION_REQUIRED"
  ) {
    return 2;
  }
  if (
    error instanceof DeploymentError &&
    error.code === "PROMPT_CANCELLED"
  ) {
    return 130;
  }
  return 1;
};

export const writeFailure = (
  io: CliIO,
  json: boolean,
  error: unknown,
  secrets: readonly string[] = [],
): CliExitError => {
  const serialized = stableError(error, secrets);
  if (json) {
    const envelope: JsonErrorEnvelope = {
      contractVersion: 1,
      ok: false,
      error: serialized,
    };
    io.stdout(`${JSON.stringify(envelope)}\n`);
  } else {
    const recovery = humanRecovery(serialized);
    io.stderr(`${[
      `Error: ${humanMessage(serialized)}`,
      ...(recovery ? [`Try: ${recovery}`] : []),
      `Code: ${serialized.code}`,
    ].join("\n")}\n`);
  }
  return new CliExitError(errorExitCode(error));
};
