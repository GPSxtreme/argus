#!/bin/sh
set -eu

platforms="${ARGUS_IMAGE_PLATFORMS:-linux/amd64,linux/arm64}"
output_directory="$(mktemp -d)"
trap 'rm -rf "$output_directory"' EXIT HUP INT TERM

docker buildx build \
  --file deploy/docker/Dockerfile \
  --output "type=oci,dest=${output_directory}/argus-app.tar" \
  --platform "$platforms" \
  .

docker buildx build \
  --file deploy/docker/Dockerfile.cli \
  --output "type=oci,dest=${output_directory}/argus-cli.tar" \
  --platform "$platforms" \
  .
