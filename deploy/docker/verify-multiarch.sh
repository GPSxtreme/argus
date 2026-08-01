#!/bin/sh
set -eu

platforms="$(node -e "const matrix=require('./deploy/docker/build-matrix.json');if(!Array.isArray(matrix.platforms)||matrix.platforms.length===0)process.exit(1);process.stdout.write(matrix.platforms.join(','))")"
timeout_seconds="${ARGUS_IMAGE_BUILD_TIMEOUT_SECONDS:-1200}"
output_directory="$(mktemp -d)"
trap 'rm -rf "$output_directory"' EXIT HUP INT TERM

run_bounded() {
  "$@" &
  command_pid="$!"
  (
    sleep "$timeout_seconds"
    echo "multi-architecture build exceeded ${timeout_seconds}s" >&2
    kill -TERM "$command_pid" 2>/dev/null || true
  ) &
  watchdog_pid="$!"
  set +e
  wait "$command_pid"
  status="$?"
  set -e
  kill "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true
  return "$status"
}

run_bounded docker buildx build \
  --file deploy/docker/Dockerfile \
  --output "type=oci,dest=${output_directory}/argus-app.tar" \
  --platform "$platforms" \
  .

run_bounded docker buildx build \
  --file deploy/docker/Dockerfile.cli \
  --output "type=oci,dest=${output_directory}/argus-cli.tar" \
  --platform "$platforms" \
  .
