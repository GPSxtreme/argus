export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  jitter?: number;
}

export const backoffDelay = (
  attempt: number,
  options: BackoffOptions,
  random: () => number = Math.random,
): number => {
  const bounded = Math.min(options.maxMs, options.baseMs * 2 ** attempt);
  const jitter = options.jitter ?? 0.2;
  return Math.round(bounded * (1 - jitter + random() * jitter * 2));
};
