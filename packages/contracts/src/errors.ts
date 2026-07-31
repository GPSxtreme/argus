export type ArgusErrorKind =
  | "validation"
  | "authentication"
  | "rate_limit"
  | "not_found"
  | "retryable"
  | "fatal";

export interface ArgusError {
  kind: ArgusErrorKind;
  message: string;
  retryAfterMs?: number;
  cause?: unknown;
}

const redact = (message: string, secrets: string[]): string =>
  secrets
    .filter(Boolean)
    .reduce((result, secret) => result.replaceAll(secret, "[REDACTED]"), message);

export const normalizeError = (
  value: unknown,
  secrets: string[] = [],
): ArgusError => {
  const message = redact(
    value instanceof Error ? value.message : String(value),
    secrets,
  );
  return {
    kind: "retryable",
    message,
    ...(value instanceof Error ? { cause: value } : {}),
  };
};
