import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";
import { type ArgusConfig, validateConfig } from "./schema.js";
import {
  projectPostgresUrlCredentials,
  withoutUrlCredentials,
} from "./sanitize.js";

const SECRET_REFERENCE = /^\$\{([A-Z][A-Z0-9_]*)\}$/u;
export const DEFAULT_CONFIG_FILENAME = "argus.yaml";

export interface ResolveConfigPathInput {
  explicitPath?: string;
  environment?: Record<string, string | undefined>;
  cwd?: string;
}

export const resolveConfigPath = (
  input: ResolveConfigPathInput = {},
): string =>
  resolve(
    input.cwd ?? process.cwd(),
    input.explicitPath ??
      (input.environment ?? process.env).ARGUS_CONFIG ??
      DEFAULT_CONFIG_FILENAME,
  );

export const resolveSecretReference = (
  value: string,
  environment: Record<string, string | undefined>,
): string => {
  const match = SECRET_REFERENCE.exec(value);
  if (!match) return value;
  const name = match[1] as string;
  const resolved = environment[name];
  if (!resolved) throw new Error(`Missing environment variable: ${name}`);
  return resolved;
};

const resolveTree = (
  value: unknown,
  environment: Record<string, string | undefined>,
): unknown => {
  if (typeof value === "string") {
    return resolveSecretReference(value, environment);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveTree(entry, environment));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        resolveTree(entry, environment),
      ]),
    );
  }
  return value;
};

export const loadConfig = async (
  path: string,
  environment: Record<string, string | undefined> = process.env,
): Promise<ArgusConfig> => {
  const document = parse(await readFile(path, "utf8")) as unknown;
  return validateConfig(resolveTree(document, environment));
};

export const serializeRedactedConfig = (config: ArgusConfig): string => {
  const redacted = structuredClone(config);
  if (redacted.intelligence.apiKey) {
    redacted.intelligence.apiKey = "[REDACTED]";
  }
  if (redacted.api.token) {
    redacted.api.token = "[REDACTED]";
  }
  if (redacted.storage.adapter === "postgres") {
    redacted.storage.url = projectPostgresUrlCredentials(
      redacted.storage.url,
    ).safeUrl;
  }
  redacted.sources.x.endpoint = withoutUrlCredentials(
    redacted.sources.x.endpoint,
  );
  if (redacted.sources.web.searchEndpoint) {
    redacted.sources.web.searchEndpoint = withoutUrlCredentials(
      redacted.sources.web.searchEndpoint,
    );
  }
  return stringify(redacted);
};
