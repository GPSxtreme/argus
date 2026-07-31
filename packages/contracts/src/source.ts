import type { SourceItem, SourceName } from "./domain.js";

export interface SourceCapabilities {
  polling: boolean;
  backfill: boolean;
  realtime: boolean;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface PullInput<C = unknown, K = unknown> {
  targetId: string;
  config: C;
  checkpoint?: K;
  signal?: AbortSignal;
}

export interface SourceAdapter<C = unknown, K = unknown> {
  readonly kind: SourceName;
  readonly capabilities: SourceCapabilities;
  validate(config: C): Promise<ValidationResult>;
  pull(input: PullInput<C, K>): AsyncIterable<SourceItem>;
}
