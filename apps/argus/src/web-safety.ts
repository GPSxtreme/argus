import { lookup } from "node:dns/promises";

export type DiagnosticResolver = (hostname: string) => Promise<Array<{ address: string }>>;

const privateAddress = (value: string): boolean =>
  /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|224\.|::1$|fc|fd|fe80)/i.test(value);

export const nodeDiagnosticResolver: DiagnosticResolver = async (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

/** Validates a configured web target without exposing its host or URL in errors. */
export const safeDiagnosticWebTarget = async (
  value: string,
  resolver: DiagnosticResolver = nodeDiagnosticResolver,
  timeoutMs = 2_000,
): Promise<boolean> => {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hostname === "localhost" || privateAddress(url.hostname)) return false;
  try {
    const answers = await Promise.race([resolver(url.hostname), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs))]);
    return answers.length > 0 && answers.every((answer) => !privateAddress(answer.address));
  } catch { return false; }
};
