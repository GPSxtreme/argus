# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG DEBIAN_SNAPSHOT=20260731T000000Z
ARG TINI_VERSION=0.19.0-1+b3

# The digest is the official Node 24 bookworm-slim OCI index. It contains both
# linux/amd64 and linux/arm64/v8 manifests and is shared by every stage.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS build

RUN corepack enable

WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json ./
COPY apps/argus/package.json apps/argus/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/engine/package.json packages/engine/package.json
COPY packages/intelligence/package.json packages/intelligence/package.json
COPY packages/query/package.json packages/query/package.json
COPY packages/scheduler/package.json packages/scheduler/package.json
COPY packages/source-telegram/package.json packages/source-telegram/package.json
COPY packages/source-web/package.json packages/source-web/package.json
COPY packages/source-x/package.json packages/source-x/package.json
COPY packages/storage-postgres/package.json packages/storage-postgres/package.json
COPY packages/storage-sqlite/package.json packages/storage-sqlite/package.json
COPY packages/storage-test-support/package.json packages/storage-test-support/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY deploy/docker/generate-third-party-notices.mjs /workspace/generate-third-party-notices.mjs
COPY deploy/docker/license-exceptions.json /workspace/license-exceptions.json
COPY deploy/docker/legal /workspace/legal
COPY apps/argus apps/argus
COPY packages/config packages/config
COPY packages/contracts packages/contracts
COPY packages/engine packages/engine
COPY packages/intelligence packages/intelligence
COPY packages/query packages/query
COPY packages/scheduler packages/scheduler
COPY packages/source-telegram packages/source-telegram
COPY packages/source-web packages/source-web
COPY packages/source-x packages/source-x
COPY packages/storage-postgres packages/storage-postgres
COPY packages/storage-sqlite packages/storage-sqlite
COPY packages/storage-test-support packages/storage-test-support

RUN pnpm --filter @argus/app... build \
  && pnpm exec esbuild apps/argus/src/main.ts \
    --bundle \
    --external:better-sqlite3 \
    --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' \
    --format=esm \
    --outfile=/workspace/app-main.js \
    --packages=bundle \
    --platform=node \
    --target=node24 \
  && jsdom_worker="$(find node_modules/.pnpm -path '*/jsdom/lib/jsdom/living/xhr/xhr-sync-worker.js' -type f -print -quit)" \
  && test -n "$jsdom_worker" \
  && pnpm exec esbuild "$jsdom_worker" \
    --bundle \
    --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' \
    --format=esm \
    --outfile=/workspace/xhr-sync-worker.js \
    --packages=bundle \
    --platform=node \
    --target=node24 \
  && pnpm --config.ignore-scripts=true --filter @argus/app deploy --legacy --prod /workspace/deployed
ARG TINI_VERSION
RUN node /workspace/generate-third-party-notices.mjs \
    /workspace/deployed/node_modules /workspace/notices app \
    "{\"tini\":\"${TINI_VERSION}\"}"

# Native compilation runs under the target platform (QEMU when cross-building).
# The package source came from the integrity-verified pnpm lockfile and install
# scripts were disabled, so no native artifact is downloaded or executed.
FROM --platform=$TARGETPLATFORM node:24-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS native-build

ARG TARGETARCH
ARG DEBIAN_SNAPSHOT
COPY deploy/docker/configure-snapshot.sh /usr/local/bin/configure-snapshot.sh
RUN DEBIAN_SNAPSHOT="$DEBIAN_SNAPSHOT" sh /usr/local/bin/configure-snapshot.sh \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential=12.9 \
    file=1:5.44-3 \
    python3=3.11.2-1+b1 \
  && rm -f /usr/local/bin/configure-snapshot.sh \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /workspace/deployed /workspace/deployed
RUN case "$TARGETARCH" in \
      amd64) expected="x86-64" ;; \
      arm64) expected="ARM aarch64" ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
  && package_dir="$(find /workspace/deployed/node_modules/.pnpm -path '*/node_modules/better-sqlite3' -type d -print -quit)" \
  && test -n "$package_dir" \
  && find "$package_dir" -name '*.node' -type f -delete \
  && (cd "$package_dir" \
    && npm_config_build_from_source=true \
      npm_config_nodedir=/usr/local \
      node /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild --release) \
  && native_module="$(find /workspace/deployed/node_modules/.pnpm -path '*/better-sqlite3/build/Release/better_sqlite3.node' -type f -print -quit)" \
  && test -n "$native_module" \
  && file "$native_module" | grep -F "$expected" \
  && install -d /workspace/runtime-node-modules/better-sqlite3/build/Release \
    /workspace/runtime-node-modules/better-sqlite3/lib \
    /workspace/runtime-node-modules/bindings \
    /workspace/runtime-node-modules/file-uri-to-path \
  && cp -R "$package_dir/lib/." /workspace/runtime-node-modules/better-sqlite3/lib/ \
  && cp "$package_dir/package.json" "$package_dir/LICENSE" /workspace/runtime-node-modules/better-sqlite3/ \
  && cp "$native_module" /workspace/runtime-node-modules/better-sqlite3/build/Release/ \
  && bindings_dir="$(find /workspace/deployed/node_modules/.pnpm -path '*/node_modules/bindings' -type d -print -quit)" \
  && cp "$bindings_dir/bindings.js" "$bindings_dir/package.json" "$bindings_dir/LICENSE.md" /workspace/runtime-node-modules/bindings/ \
  && file_uri_dir="$(find /workspace/deployed/node_modules/.pnpm -path '*/node_modules/file-uri-to-path' -type d -print -quit)" \
  && cp "$file_uri_dir/index.js" "$file_uri_dir/package.json" "$file_uri_dir/LICENSE" /workspace/runtime-node-modules/file-uri-to-path/ \
  && ! find /workspace/runtime-node-modules -type f \
    \( -name '*.gyp' -o -name '*.cpp' -o -name '*.c' -o -name '*.h' \) | grep .

FROM --platform=$TARGETPLATFORM node:24-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS runtime

ARG DEBIAN_SNAPSHOT
ARG TINI_VERSION
ARG ARGUS_VERSION=0.0.0-dev
ARG ARGUS_REVISION=unknown
ARG ARGUS_SOURCE=https://github.com/gpsxtreme/argus
LABEL org.opencontainers.image.title="Argus" \
  org.opencontainers.image.description="Argus data ingestion runtime" \
  org.opencontainers.image.source="$ARGUS_SOURCE" \
  org.opencontainers.image.revision="$ARGUS_REVISION" \
  org.opencontainers.image.version="$ARGUS_VERSION"

COPY deploy/docker/configure-snapshot.sh /usr/local/bin/configure-snapshot.sh
RUN DEBIAN_SNAPSHOT="$DEBIAN_SNAPSHOT" sh /usr/local/bin/configure-snapshot.sh \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates=20230311+deb12u1 \
    tini="$TINI_VERSION" \
  && groupadd --gid 10001 argus \
  && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /app --shell /usr/sbin/nologin argus \
  && mkdir -p /app/apps/argus/dist /app/data /app/node_modules \
  && chown -R 10001:10001 /app \
  && rm -f /usr/local/bin/configure-snapshot.sh \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build --chown=10001:10001 /workspace/app-main.js /app/apps/argus/dist/main.js
COPY --from=build --chown=10001:10001 /workspace/xhr-sync-worker.js /app/apps/argus/dist/xhr-sync-worker.js
COPY --from=build --chown=10001:10001 /workspace/apps/argus/package.json /app/apps/argus/package.json
COPY --from=native-build --chown=10001:10001 /workspace/runtime-node-modules/ /app/node_modules/
COPY --from=build --chown=10001:10001 /workspace/notices/THIRD_PARTY_NOTICES.md /app/THIRD_PARTY_NOTICES.md
COPY --from=build --chown=10001:10001 /workspace/notices/licenses/ /app/licenses/
RUN cp /usr/share/doc/tini/copyright /app/licenses/tini-copyright \
  && chown 10001:10001 /app/licenses/tini-copyright

ENV NODE_ENV="production"
ENV ARGUS_CONFIG="/app/argus.yaml"
ENV ARGUS_ROLE="all"
WORKDIR /app
VOLUME ["/app/data"]
EXPOSE 8788
USER 10001:10001

HEALTHCHECK --interval=5s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8788/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--", "node", "/app/apps/argus/dist/main.js"]
