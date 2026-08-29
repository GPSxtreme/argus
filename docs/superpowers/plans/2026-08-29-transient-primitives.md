# Transient Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let authenticated agents call bounded FxTwitter v2 and SearXNG search primitives through Argus without writing any persistent state.

**Architecture:** Small route modules validate and normalize the requested operation, then use the existing safe HTTP boundary with stricter same-origin redirects and response streaming caps. A fixed in-process token/source limiter protects upstreams. Repository mutation is absent from the primitive module interfaces.

**Tech Stack:** Hono, native Fetch, TypeScript, Vitest

**Spec:** `docs/superpowers/specs/2026-08-29-rich-records-and-context-pipelines-design.md`

## Global Constraints

- Primitive calls are transient and read-only.
- The client cannot choose an upstream origin.
- X permits only `GET` and `HEAD` under normalized `/2/` paths.
- SearXNG exposes search, never administration.
- Responses, redirects, timeouts, logs, and request rate are bounded.

---

### Task 1: Primitive request policy

**Files:**
- Create: `apps/argus/src/primitives/policy.ts`
- Create: `apps/argus/src/primitives/rate-limit.ts`
- Create: `apps/argus/test/primitive-policy.test.ts`

**Interfaces:**
- Produces: `resolveXPrimitive(endpoint, path, query): URL`.
- Produces: `PrimitiveRateLimiter.consume(tokenDigest, source, now): { allowed: boolean; retryAfterSeconds?: number }`.

- [ ] **Step 1: Write failing literal-corpus tests** for valid `/2/status/20`, dot segments, double encoding, credentials, fragments, cross-origin endpoints, overlong URLs, and the 61st request in one minute.
- [ ] **Step 2: Run the policy test and verify RED.**
- [ ] **Step 3: Implement strict URL segment decoding/re-encoding and a 60-request fixed window.**

```ts
if (!pathname.startsWith("/2/") || pathname.split("/").some(isDotSegment)) {
  throw new PrimitiveBoundaryError("PRIMITIVE_PATH_INVALID");
}
const upstream = new URL(pathname.slice(1) + search, configuredEndpoint);
if (upstream.origin !== configuredEndpoint.origin) throw new PrimitiveBoundaryError("PRIMITIVE_ORIGIN_INVALID");
```

- [ ] **Step 4: Run tests/typecheck and commit `feat: define primitive request policy`.**

### Task 2: Bounded upstream transport

**Files:**
- Create: `apps/argus/src/primitives/transport.ts`
- Create: `apps/argus/test/primitive-transport.test.ts`
- Modify: `packages/source-web/src/safe-http.ts`
- Modify: `packages/source-web/test/web.test.ts`

**Interfaces:**
- Produces: `requestPrimitive(input): Promise<{ status; contentType; body; bytes; durationMs }>`.

- [ ] **Step 1: Write failing real-server tests** for same-origin redirect, cross-origin redirect, timeout, 2 MiB success, first-byte-over-cap failure, and stripped authorization/cookie/forwarding headers.
- [ ] **Step 2: Run transport tests and verify RED.**
- [ ] **Step 3: Extract the reusable bounded byte reader from safe HTTP and implement transport.** Only `accept: application/json` and Argus user agent are emitted; redirect handling is manual and limited to five hops.
- [ ] **Step 4: Run source-web and transport tests; commit `feat: add bounded primitive transport`.**

### Task 3: FxTwitter and SearXNG routes

**Files:**
- Create: `apps/argus/src/primitives/x.ts`
- Create: `apps/argus/src/primitives/searxng.ts`
- Create: `apps/argus/src/primitives/index.ts`
- Modify: `apps/argus/src/app.ts`
- Modify: `apps/argus/test/app.test.ts`

**Interfaces:**
- Produces: `GET|HEAD /v1/primitives/x/2/*` and `GET /v1/primitives/web/search`.

- [ ] **Step 1: Write failing route tests** for missing API token configuration, missing/wrong bearer token, byte-preserving success/status/content type, SearXNG forced JSON, rate limit, and upstream boundary errors.
- [ ] **Step 2: Add a repository double whose every method throws `repository mutation attempted`**, call every primitive route, and verify successful responses prove no method was invoked.
- [ ] **Step 3: Run route tests and verify RED.**
- [ ] **Step 4: Register handlers through `createPrimitiveRouter({ config, fetcher, logger, limiter })`.** Preserve safe upstream status and body; map only Argus boundary failures to the stable JSON error envelope.
- [ ] **Step 5: Run focused tests and commit `feat: expose transient source primitives`.**

### Task 4: Primitive integration and security gate

**Files:**
- Create: `test/e2e/primitives.test.ts`
- Modify: `apps/argus/test/web-safety.test.ts`
- Modify: `apps/web/content/docs/security.mdx`

**Interfaces:**
- Tests the production Hono app against local FxTwitter/SearXNG fixtures.

- [ ] **Step 1: Write the failing e2e test** that calls X conversation and SearXNG search, checks raw bodies, then verifies all repository tables remain empty.
- [ ] **Step 2: Run the e2e test and verify RED before final wiring.**
- [ ] **Step 3: Complete runtime dependency injection and concise security documentation.**
- [ ] **Step 4: Run `pnpm test && pnpm typecheck && pnpm build && pnpm lint`; expect all gates PASS.**
- [ ] **Step 5: Commit with `git commit -m "test: verify transient primitive gateway"`.**
