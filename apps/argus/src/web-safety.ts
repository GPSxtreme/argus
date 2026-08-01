import { isIP } from "node:net";
import {
  nodeWebResolver,
  resolvePublicWebUrl,
  type WebResolver,
} from "@argus/source-web";

export type DiagnosticResolver = (
  hostname: string,
) => Promise<ReadonlyArray<{ address: string; family?: 4 | 6 }>>;

export const nodeDiagnosticResolver: DiagnosticResolver = nodeWebResolver;

/** Validates a configured web target without exposing its host or URL in errors. */
export const safeDiagnosticWebTarget = async (
  value: string,
  resolver: DiagnosticResolver = nodeDiagnosticResolver,
  timeoutMs = 2_000,
): Promise<boolean> => {
  const sharedResolver: WebResolver = async (hostname) =>
    (await resolver(hostname)).map((answer) => ({
      address: answer.address,
      family: answer.family ?? (isIP(answer.address) === 6 ? 6 : 4),
    }));
  try {
    await resolvePublicWebUrl(value, sharedResolver, timeoutMs);
    return true;
  } catch {
    return false;
  }
};
