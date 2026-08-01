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
