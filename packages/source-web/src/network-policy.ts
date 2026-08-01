import { isIP, isIPv4 } from "node:net";
import { lookup } from "node:dns/promises";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type WebResolver = (
  hostname: string,
) => Promise<readonly ResolvedAddress[]>;

export class SafeWebError extends Error {
  constructor(
    readonly code:
      | "WEB_DESTINATION_INVALID"
      | "WEB_DESTINATION_NOT_PUBLIC"
      | "WEB_DNS_FAILED"
      | "WEB_REDIRECT_INVALID"
      | "WEB_REDIRECT_LOOP"
      | "WEB_TOO_MANY_REDIRECTS"
      | "WEB_RESPONSE_TOO_LARGE"
      | "WEB_REQUEST_FAILED",
  ) {
    super("Web request was rejected by the destination policy");
    this.name = "SafeWebError";
  }
}

const ipv4Number = (address: string): number | undefined => {
  if (!isIPv4(address)) return undefined;
  return address
    .split(".")
    .reduce((value, part) => value * 256 + Number(part), 0);
};

const inIpv4Range = (
  address: number,
  network: number,
  prefix: number,
): boolean => {
  const divisor = 2 ** (32 - prefix);
  return Math.floor(address / divisor) === Math.floor(network / divisor);
};

const blockedIpv4Ranges: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0000200, 24],
  [0xc0a80000, 16],
  [0xc6120000, 15],
  [0xc6336400, 24],
  [0xcb007100, 24],
  [0xe0000000, 4],
  [0xf0000000, 4],
];

const parseIpv6 = (input: string): Uint8Array | undefined => {
  const address = input.startsWith("[") && input.endsWith("]")
    ? input.slice(1, -1)
    : input;
  if (address.includes("%")) return undefined;
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const parseHalf = (value: string): number[] | undefined => {
    if (!value) return [];
    const segments = value.split(":");
    const words: number[] = [];
    for (const segment of segments) {
      if (segment.includes(".")) {
        const v4 = ipv4Number(segment);
        if (v4 === undefined || segment !== segments.at(-1)) return undefined;
        words.push(Math.floor(v4 / 65_536), v4 % 65_536);
      } else {
        if (!/^[\da-f]{1,4}$/iu.test(segment)) return undefined;
        words.push(Number.parseInt(segment, 16));
      }
    }
    return words;
  };
  const left = parseHalf(halves[0] ?? "");
  const right = parseHalf(halves[1] ?? "");
  if (!left || !right) return undefined;
  const omitted = 8 - left.length - right.length;
  if (
    (halves.length === 1 && omitted !== 0) ||
    (halves.length === 2 && omitted < 1)
  ) {
    return undefined;
  }
  const words = [...left, ...Array.from({ length: omitted }, () => 0), ...right];
  if (words.length !== 8) return undefined;
  return Uint8Array.from(words.flatMap((word) => [word >> 8, word & 0xff]));
};

export const isPublicIpAddress = (address: string): boolean => {
  const v4 = ipv4Number(address);
  if (v4 !== undefined) {
    return !blockedIpv4Ranges.some(([network, prefix]) =>
      inIpv4Range(v4, network, prefix),
    );
  }

  const v6 = parseIpv6(address);
  if (!v6) return false;
  const byte = (index: number): number => v6[index] ?? 0;
  const mappedIpv4 =
    v6.slice(0, 10).every((byte) => byte === 0) &&
    byte(10) === 0xff &&
    byte(11) === 0xff;
  if (mappedIpv4) {
    return isPublicIpAddress(
      `${byte(12)}.${byte(13)}.${byte(14)}.${byte(15)}`,
    );
  }

  // Only globally routed unicast (2000::/3) is eligible.
  if ((byte(0) & 0xe0) !== 0x20) return false;
  // IETF protocol assignments, benchmarking, documentation, and 6to4.
  if (byte(0) === 0x20 && byte(1) === 0x01 && byte(2) <= 0x01)
    return false;
  if (
    byte(0) === 0x20 &&
    byte(1) === 0x01 &&
    byte(2) === 0x00 &&
    byte(3) === 0x02
  ) {
    return false;
  }
  if (
    byte(0) === 0x20 &&
    byte(1) === 0x01 &&
    (byte(2) & 0xf0) === 0x20
  ) {
    return false;
  }
  if (
    byte(0) === 0x20 &&
    byte(1) === 0x01 &&
    byte(2) === 0x0d &&
    byte(3) === 0xb8
  ) {
    return false;
  }
  if (byte(0) === 0x20 && byte(1) === 0x02) return false;
  if (byte(0) === 0x3f && (byte(1) & 0xf0) === 0xf0) return false;
  return true;
};

export const nodeWebResolver: WebResolver = async (hostname) => {
  const normalized =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  const answers = await lookup(normalized, { all: true, verbatim: true });
  return answers.filter(
    (answer): answer is ResolvedAddress =>
      answer.family === 4 || answer.family === 6,
  );
};

export const parseSafeWebUrl = (value: string | URL): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SafeWebError("WEB_DESTINATION_INVALID");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    !url.hostname
  ) {
    throw new SafeWebError("WEB_DESTINATION_INVALID");
  }
  url.hash = "";
  return url;
};

export const resolvePublicWebUrl = async (
  value: string | URL,
  resolver: WebResolver = nodeWebResolver,
  timeoutMs = 2_000,
): Promise<{ url: URL; addresses: readonly ResolvedAddress[] }> => {
  const url = parseSafeWebUrl(value);
  const literalHostname =
    url.hostname.startsWith("[") && url.hostname.endsWith("]")
      ? url.hostname.slice(1, -1)
      : url.hostname;
  if (isIP(literalHostname) && !isPublicIpAddress(literalHostname)) {
    throw new SafeWebError("WEB_DESTINATION_NOT_PUBLIC");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answers = await Promise.race([
      resolver(url.hostname),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new SafeWebError("WEB_DNS_FAILED")),
          timeoutMs,
        );
      }),
    ]);
    if (
      answers.length === 0 ||
      answers.some((answer) => !isPublicIpAddress(answer.address))
    ) {
      throw new SafeWebError("WEB_DESTINATION_NOT_PUBLIC");
    }
    return { url, addresses: answers };
  } catch (error) {
    if (error instanceof SafeWebError) throw error;
    throw new SafeWebError("WEB_DNS_FAILED");
  } finally {
    if (timer) clearTimeout(timer);
  }
};
