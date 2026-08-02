import { isIP } from "node:net";

export const POSTGRES_URL_ERROR =
  "PostgreSQL URL must use postgres:// or postgresql:// with a nonempty host and valid percent encoding.";
export const URL_REDACTION_ERROR =
  "Configuration URL could not be safely redacted.";

const invalidPercentEncoding = /%(?![0-9a-f]{2})/iu;
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu;

const isSupportedTcpHost = (value: string): boolean => {
  if (value.startsWith("[") && value.endsWith("]")) {
    return isIP(value.slice(1, -1)) === 6;
  }
  if (isIP(value) !== 0) return true;

  const hostname = value.endsWith(".") ? value.slice(0, -1) : value;
  return (
    hostname.length > 0 &&
    hostname.length <= 253 &&
    hostname
      .split(".")
      .every((label) => label.length <= 63 && dnsLabel.test(label))
  );
};

export const parseCanonicalPostgresUrl = (value: string): URL => {
  if (invalidPercentEncoding.test(value)) {
    throw new Error(POSTGRES_URL_ERROR);
  }

  let url: URL;
  try {
    url = new URL(value);
    if (
      (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
      !url.hostname ||
      url.hash
    ) {
      throw new Error(POSTGRES_URL_ERROR);
    }

    // pg decodes these components again while opening the connection. Validate
    // them here so its parser cannot surface a credential-bearing URIError.
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    const authorityHost = decodeURIComponent(url.hostname);
    decodeURI(url.pathname);

    let queryHost: string | undefined;
    let queryPort: string | undefined;
    for (const [key, entry] of url.searchParams.entries()) {
      if (key === "host") queryHost = entry;
      if (key === "port") queryPort = entry;
    }
    if (
      !isSupportedTcpHost(authorityHost) ||
      (queryHost !== undefined &&
        queryHost !== "" &&
        !isSupportedTcpHost(queryHost)) ||
      (queryPort !== undefined &&
        queryPort !== "" &&
        (!/^\d+$/u.test(queryPort) ||
          Number(queryPort) < 1 ||
          Number(queryPort) > 65_535))
    ) {
      throw new Error(POSTGRES_URL_ERROR);
    }
  } catch {
    throw new Error(POSTGRES_URL_ERROR);
  }

  return url;
};

export const isCanonicalPostgresUrl = (value: string): boolean => {
  try {
    parseCanonicalPostgresUrl(value);
    return true;
  } catch {
    return false;
  }
};

export const assertCanonicalPostgresUrl = (value: string): void => {
  parseCanonicalPostgresUrl(value);
};

export const withoutUrlCredentials = (value: string): string => {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    throw new Error(URL_REDACTION_ERROR);
  }
};

export interface PostgresUrlCredentialProjection {
  safeUrl: string;
  effectiveCredential?: string;
}

export const projectPostgresUrlCredentials = (
  value: string,
): PostgresUrlCredentialProjection => {
  const url = parseCanonicalPostgresUrl(value);

  let queryUser: string | undefined;
  let queryPassword: string | undefined;
  const safeParameters: Array<[string, string]> = [];
  for (const [key, entry] of url.searchParams.entries()) {
    if (key === "user") queryUser = entry;
    if (key === "password") queryPassword = entry;
    if (key.toLowerCase() !== "user" && key.toLowerCase() !== "password") {
      safeParameters.push([key, entry]);
    }
  }

  const authorityUser = decodeURIComponent(url.username);
  const authorityPassword = decodeURIComponent(url.password);
  const effectiveUser = queryUser || authorityUser;
  const effectivePassword = queryPassword || authorityPassword;

  url.username = "";
  url.password = "";
  url.search = "";
  for (const [key, entry] of safeParameters) {
    url.searchParams.append(key, entry);
  }

  return {
    safeUrl: url.toString(),
    ...(!effectiveUser && !effectivePassword
      ? {}
      : {
          effectiveCredential:
            `postgres-user\u0000${effectiveUser}` +
            `\u0000postgres-password\u0000${effectivePassword}`,
        }),
  };
};

export const urlCredentialFingerprint = (
  value: string,
  fingerprint: (credential: string) => string,
): string | undefined => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!url.username && !url.password) return undefined;
  return fingerprint(`${url.username}\u0000${url.password}`);
};
