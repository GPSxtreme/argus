export const withoutUrlCredentials = (value: string): string => {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return value;
  }
};

export interface PostgresUrlCredentialProjection {
  safeUrl: string;
  effectiveCredential?: string;
}

export const projectPostgresUrlCredentials = (
  value: string,
): PostgresUrlCredentialProjection => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { safeUrl: value };
  }

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
