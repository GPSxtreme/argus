#!/bin/sh
set -eu

argus_vps_die() {
  printf '%s\n' "argus VPS smoke: $*" >&2
  exit 1
}

argus_vps_required() {
  eval "argus_vps_value=\${$1:-}"
  [ -n "$argus_vps_value" ] || argus_vps_die "$1 is required"
}

[ "${ARGUS_VPS_E2E:-0}" = 1 ] ||
  argus_vps_die "set ARGUS_VPS_E2E=1 to run this destructive disposable-host test"

if [ "${1:-}" != "--inner" ]; then
  argus_vps_rootfs=${1:-}
  case "$argus_vps_rootfs" in
    ubuntu:24.04|debian:13) ;;
    *) argus_vps_die "usage: ARGUS_VPS_E2E=1 $0 ubuntu:24.04|debian:13" ;;
  esac
  for argus_vps_name in \
    ARGUS_INSTALLER_URL \
    ARGUS_MANIFEST_URL \
    ARGUS_MANIFEST_ASSET_URL \
    ARGUS_EXPECTED_VERSION \
    ARGUS_UPDATE_MANIFEST_ASSET_URL \
    ARGUS_UPDATE_MANIFEST_SHA256 \
    ARGUS_UPDATE_EXPECTED_VERSION
  do
    argus_vps_required "$argus_vps_name"
  done
  for argus_vps_command in docker jq mktemp; do
    command -v "$argus_vps_command" >/dev/null 2>&1 ||
      argus_vps_die "$argus_vps_command is required"
  done
  [ -S /var/run/docker.sock ] ||
    argus_vps_die "the Docker socket is unavailable"

  argus_vps_repo=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd -P)
  argus_vps_work=$(mktemp -d "${TMPDIR:-/tmp}/argus-vps-e2e.XXXXXX")
  argus_vps_image="argus-vps-e2e:$(printf '%s' "$argus_vps_rootfs" | tr ':/' '--')"
  argus_vps_sentinel=/opt/argus/.argus-vps-e2e

  argus_vps_cleanup_outer() {
    argus_vps_status=$?
    docker rm -f argus-vps-e2e >/dev/null 2>&1 || true
    if [ -f "$argus_vps_sentinel" ]; then
      sudo find /opt/argus -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
      sudo rmdir /opt/argus 2>/dev/null || true
    fi
    rm -rf "$argus_vps_work"
    exit "$argus_vps_status"
  }
  trap argus_vps_cleanup_outer EXIT HUP INT TERM

  [ ! -e /opt/argus ] ||
    argus_vps_die "refusing a host with an existing /opt/argus"
  sudo install -d -m 0755 /opt/argus
  sudo install -m 0600 /dev/null "$argus_vps_sentinel"

  cat > "$argus_vps_work/Dockerfile" <<'ARGUS_VPS_DOCKERFILE'
ARG ROOTFS
FROM ${ROOTFS}
ARG TARGETARCH
ARG DOCKER_VERSION=29.7.1
ARG COMPOSE_VERSION=2.39.1
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates coreutils curl expect iproute2 jq openssl procps \
  && rm -rf /var/lib/apt/lists/*
RUN case "$TARGETARCH" in \
      amd64) asset_arch=x86_64; docker_sha=0fcea2a8b4d1b54ccc9010e3451b78504a369d414f37eb3bb79300e1b5c22ce6; compose_sha=a5ea28722d5da628b59226626f7d6c33c89a7ed19e39f750645925242044c9d2 ;; \
      arm64) asset_arch=aarch64; docker_sha=4eb4d1b21131897ed3990aac31039161bf4bdd07fcfb733e996010319ff4e069; compose_sha=7b2627ed76f7dcb0d93f649f185af912372229b4c09762a3cd1db5be5255632b ;; \
      *) exit 1 ;; \
    esac \
  && curl --fail --location --proto '=https' --tlsv1.2 --retry 3 \
    "https://download.docker.com/linux/static/stable/${asset_arch}/docker-${DOCKER_VERSION}.tgz" \
    --output /tmp/docker.tgz \
  && printf '%s  %s\n' "$docker_sha" /tmp/docker.tgz | sha256sum --check --strict \
  && tar -xzf /tmp/docker.tgz -C /tmp \
  && install -m 0755 /tmp/docker/docker /usr/local/bin/docker \
  && curl --fail --location --proto '=https' --tlsv1.2 --retry 3 \
    "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-${asset_arch}" \
    --output /tmp/docker-compose \
  && printf '%s  %s\n' "$compose_sha" /tmp/docker-compose | sha256sum --check --strict \
  && install -D -m 0755 /tmp/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose
WORKDIR /workspace
ARGUS_VPS_DOCKERFILE

  docker build \
    --build-arg "ROOTFS=$argus_vps_rootfs" \
    --file "$argus_vps_work/Dockerfile" \
    --tag "$argus_vps_image" \
    "$argus_vps_work"

  docker run --name argus-vps-e2e --rm --network host \
    --volume /var/run/docker.sock:/var/run/docker.sock \
    --volume /opt/argus:/opt/argus \
    --volume "$argus_vps_repo:/workspace:ro" \
    --env ARGUS_VPS_E2E=1 \
    --env ARGUS_INSTALLER_URL \
    --env ARGUS_MANIFEST_URL \
    --env ARGUS_MANIFEST_ASSET_URL \
    --env ARGUS_EXPECTED_VERSION \
    --env ARGUS_UPDATE_MANIFEST_ASSET_URL \
    --env ARGUS_UPDATE_MANIFEST_SHA256 \
    --env ARGUS_UPDATE_EXPECTED_VERSION \
    --env ARGUS_CONTROLLED_WEB_URL \
    --env ARGUS_GITHUB_TOKEN \
    --env ARGUS_GITHUB_USER \
    "$argus_vps_image" \
    sh /workspace/scripts/e2e/vps-smoke.sh --inner
  exit 0
fi

[ "$(id -u)" -eq 0 ] || argus_vps_die "the inner clean-host test must run as root"
for argus_vps_name in \
  ARGUS_INSTALLER_URL \
  ARGUS_MANIFEST_URL \
  ARGUS_MANIFEST_ASSET_URL \
  ARGUS_EXPECTED_VERSION \
  ARGUS_UPDATE_MANIFEST_ASSET_URL \
  ARGUS_UPDATE_MANIFEST_SHA256 \
  ARGUS_UPDATE_EXPECTED_VERSION
do
  argus_vps_required "$argus_vps_name"
done
[ "$(printf '%s' "$ARGUS_UPDATE_MANIFEST_SHA256" | grep -Ec '^[a-f0-9]{64}$')" = 1 ] ||
  argus_vps_die "ARGUS_UPDATE_MANIFEST_SHA256 must be lowercase SHA-256"
for argus_vps_command in base64 curl docker expect jq openssl sha256sum; do
  command -v "$argus_vps_command" >/dev/null 2>&1 ||
    argus_vps_die "$argus_vps_command is required"
done

argus_vps_work=$(mktemp -d /tmp/argus-vps-inner.XXXXXX)
argus_vps_installer=$argus_vps_work/install.sh
argus_vps_manifest=$argus_vps_work/manifest.json
argus_vps_update_manifest=$argus_vps_work/update-manifest.json
argus_vps_update_context_manifest=$argus_vps_work/update-context-manifest.json
argus_vps_first=$argus_vps_work/onboard-first.log
argus_vps_second=$argus_vps_work/onboard-second.log
argus_vps_doctor=$argus_vps_work/doctor.json
argus_vps_status_json=$argus_vps_work/status.json
argus_vps_searxng=$argus_vps_work/searxng.json
argus_vps_token="argus_vps_$(openssl rand -hex 24)"
argus_vps_headers=

argus_vps_cleanup_inner() {
  argus_vps_status=$?
  if [ -f /opt/argus/state.json ]; then
    argus stop --yes --json >/dev/null 2>&1 || true
  fi
  rm -rf "$argus_vps_work"
  exit "$argus_vps_status"
}
trap argus_vps_cleanup_inner EXIT HUP INT TERM

if [ -n "${ARGUS_GITHUB_TOKEN:-}" ]; then
  argus_vps_token_lines=$(printf '%s\n' "$ARGUS_GITHUB_TOKEN" | wc -l | tr -d '[:space:]')
  [ "$argus_vps_token_lines" = 1 ] &&
    printf '%s\n' "$ARGUS_GITHUB_TOKEN" | LC_ALL=C grep -Eq '^[!-~]+$' ||
    argus_vps_die "ARGUS_GITHUB_TOKEN contains unsafe characters"
  argus_vps_headers=$argus_vps_work/github.headers
  {
    printf 'Authorization: Bearer %s\n' "$ARGUS_GITHUB_TOKEN"
    printf '%s\n' 'X-GitHub-Api-Version: 2022-11-28'
  } > "$argus_vps_headers"
  chmod 600 "$argus_vps_headers"
fi

argus_vps_download() {
  argus_vps_url=$1
  argus_vps_target=$2
  if [ -n "$argus_vps_headers" ]; then
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      --connect-timeout 10 --max-time 120 --retry 3 --retry-all-errors \
      --header @"$argus_vps_headers" --header 'Accept: application/octet-stream' \
      --output "$argus_vps_target" "$argus_vps_url"
  else
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      --connect-timeout 10 --max-time 120 --retry 3 --retry-all-errors \
      --output "$argus_vps_target" "$argus_vps_url"
  fi
}

argus_vps_download "$ARGUS_INSTALLER_URL" "$argus_vps_installer"
argus_vps_download "$ARGUS_MANIFEST_ASSET_URL" "$argus_vps_manifest"
argus_vps_download "$ARGUS_UPDATE_MANIFEST_ASSET_URL" "$argus_vps_update_manifest"
sh -n "$argus_vps_installer"
chmod 700 "$argus_vps_installer"
ARGUS_MANIFEST_URL="$ARGUS_MANIFEST_URL" \
ARGUS_VERSION="$ARGUS_EXPECTED_VERSION" \
ARGUS_GITHUB_TOKEN="${ARGUS_GITHUB_TOKEN:-}" \
ARGUS_GITHUB_USER="${ARGUS_GITHUB_USER:-}" \
ARGUS_INSTALL_DOCKER=0 \
ARGUS_INSTALL_INSPECT=0 \
sh "$argus_vps_installer"

[ "$(argus --version)" = "$ARGUS_EXPECTED_VERSION" ] ||
  argus_vps_die "installed wrapper reported the wrong release"

argus_vps_parse_management_state() {
  argus_vps_state_path=$1
  [ -f "$argus_vps_state_path" ] && [ ! -L "$argus_vps_state_path" ] ||
    argus_vps_die "management state is not a regular file"
  argus_vps_management_state=$(jq -R -s -e '
    capture("^schema=(?<schema>[0-9]+)\\nversion=(?<version>(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?)\\ncli_image=(?<cliImage>[a-z0-9]+([._-][a-z0-9]+)*([/:][a-z0-9]+([._/-][a-z0-9]+)*)*@sha256:[a-f0-9]{64})\\n$")
    | select(.schema == "1")
  ' "$argus_vps_state_path") ||
    argus_vps_die "management state is not canonical"
  argus_vps_management_version=$(printf '%s' "$argus_vps_management_state" | jq -er '.version')
  argus_vps_management_cli_image=$(printf '%s' "$argus_vps_management_state" | jq -er '.cliImage')
}

argus_vps_initial_cli_image=$(jq -er '.images.cli.reference' "$argus_vps_manifest")
argus_vps_update_cli_image=$(jq -er '.images.cli.reference' "$argus_vps_update_manifest")
[ "$(jq -er '.version' "$argus_vps_update_manifest")" = "$ARGUS_UPDATE_EXPECTED_VERSION" ] ||
  argus_vps_die "signed update manifest reported the wrong version"
[ "$(sha256sum "$argus_vps_update_manifest" | awk 'NR == 1 { print $1 }')" = "$ARGUS_UPDATE_MANIFEST_SHA256" ] ||
  argus_vps_die "downloaded signed update manifest did not match the candidate"
[ "$ARGUS_EXPECTED_VERSION" != "$ARGUS_UPDATE_EXPECTED_VERSION" ] ||
  argus_vps_die "signed update candidate must advance the installed release"
argus_vps_controlled_url=${ARGUS_CONTROLLED_WEB_URL:-https://argus.gpsxtre.me/}
printf '%s\n' "$argus_vps_controlled_url" |
  grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._~/%?=-]*$' ||
  argus_vps_die "ARGUS_CONTROLLED_WEB_URL must be a credential-free HTTPS URL ending in a path"
sed "s#https://argus.gpsxtre.me/#$argus_vps_controlled_url#" \
  /workspace/scripts/e2e/fixtures/onboard-web.yaml \
  > /opt/argus/.vps-smoke-onboard.yaml
chmod 600 /opt/argus/.vps-smoke-onboard.yaml

argus_vps_onboard() {
  argus_vps_output=$1
  ARGUS_VPS_TOKEN=$argus_vps_token ARGUS_VPS_OUTPUT=$argus_vps_output expect <<'ARGUS_VPS_EXPECT'
log_user 0
log_file -a -noappend $env(ARGUS_VPS_OUTPUT)
set timeout 900
spawn sh -c {stty rows 24 columns 80; exec argus onboard --from /opt/argus/.vps-smoke-onboard.yaml --yes --json}
expect {
  -re {Argus API token} { send -- "$env(ARGUS_VPS_TOKEN)\r"; exp_continue }
  eof {}
  timeout { exit 124 }
}
set result [wait]
exit [lindex $result 3]
ARGUS_VPS_EXPECT
  tr -d '\r' < "$argus_vps_output" |
    sed -n '/^{.*}$/p' |
    tail -n 1 > "$argus_vps_output.json"
  jq -e '.contractVersion == 1 and .ok == true' \
    "$argus_vps_output.json" >/dev/null
}

argus_vps_onboard "$argus_vps_first"
argus_vps_onboard "$argus_vps_second"
jq -e '.data.plan.deployment.changes == []' \
  "$argus_vps_second.json" >/dev/null

argus_vps_parse_management_state /opt/argus/management.state
[ "$argus_vps_management_version" = "$ARGUS_EXPECTED_VERSION" ] &&
  [ "$argus_vps_management_cli_image" = "$argus_vps_initial_cli_image" ] ||
  argus_vps_die "installed management state did not match the signed baseline"
argus_vps_launcher_before=$(sha256sum /usr/local/bin/argus)
argus_vps_management_version_before=$argus_vps_management_version
argus_vps_management_cli_image_before=$argus_vps_management_cli_image
argus update --json --yes > "$argus_vps_work/update.json"
jq -e --arg version "$ARGUS_UPDATE_EXPECTED_VERSION" '
  .contractVersion == 1 and .ok == true and .data.version == $version and
  .data.health.healthy == true
' "$argus_vps_work/update.json" >/dev/null
[ -f /opt/argus/release-context.json ] && [ ! -L /opt/argus/release-context.json ] ||
  argus_vps_die "persisted signed update context is not a regular file"
jq -e '
  type == "object" and .schemaVersion == 1 and
  (keys | sort == ["fxembed", "manifest", "schemaVersion", "signature"]) and
  (.manifest | type == "string") and (.signature | type == "string") and
  (.fxembed | type == "string")
' /opt/argus/release-context.json >/dev/null ||
  argus_vps_die "persisted signed update context is malformed"
argus_vps_update_context_base64=$(jq -er '.manifest' /opt/argus/release-context.json)
printf '%s' "$argus_vps_update_context_base64" |
  base64 --decode > "$argus_vps_update_context_manifest" ||
  argus_vps_die "persisted signed update context manifest is not base64"
[ "$(base64 < "$argus_vps_update_context_manifest" | tr -d '\n')" = "$argus_vps_update_context_base64" ] ||
  argus_vps_die "persisted signed update context manifest is not canonical base64"
[ "$(sha256sum "$argus_vps_update_context_manifest" | awk 'NR == 1 { print $1 }')" = "$ARGUS_UPDATE_MANIFEST_SHA256" ] ||
  argus_vps_die "persisted signed update context did not match the candidate"
argus_vps_parse_management_state /opt/argus/management.state
[ "$argus_vps_management_version" = "$ARGUS_UPDATE_EXPECTED_VERSION" ] &&
  [ "$argus_vps_management_cli_image" = "$argus_vps_update_cli_image" ] &&
  [ "$argus_vps_management_version" != "$argus_vps_management_version_before" ] &&
  [ "$argus_vps_management_cli_image" != "$argus_vps_management_cli_image_before" ] ||
  argus_vps_die "management state did not advance to the signed update"
[ "$argus_vps_launcher_before" = "$(sha256sum /usr/local/bin/argus)" ] ||
  argus_vps_die "launcher changed during signed update"

argus doctor --json > "$argus_vps_doctor"
argus status --json > "$argus_vps_status_json"
jq -e \
  '.contractVersion == 1 and .ok == true and .data.healthy == true' \
  "$argus_vps_doctor" >/dev/null
jq -e \
  '.contractVersion == 1 and .ok == true and .data.state == "running" and
    (.data.services | length >= 2) and
    ([.data.services[] | select(. != "healthy" and . != "running")] | length == 0)' \
  "$argus_vps_status_json" >/dev/null

curl --fail --silent --show-error \
  --request POST \
  --header "Authorization: Bearer $argus_vps_token" \
  http://127.0.0.1:8788/v1/watches/controlled-web-page/ingest \
  >/dev/null
argus_vps_attempt=0
while :; do
  argus_vps_records=$(
    curl --fail --silent --show-error \
      --header "Authorization: Bearer $argus_vps_token" \
      "http://127.0.0.1:8788/v1/records?q=Argus&source=web"
  )
  if printf '%s' "$argus_vps_records" |
    jq -e --arg url "$argus_vps_controlled_url" \
      '.records // .items | any(.url == $url and (.title == "Argus" or (.text | contains("Argus"))))' \
      >/dev/null
  then
    break
  fi
  argus_vps_attempt=$((argus_vps_attempt + 1))
  [ "$argus_vps_attempt" -lt 30 ] ||
    argus_vps_die "controlled Web page was not ingested"
  sleep 2
done

argus_vps_cli_image=$argus_vps_update_cli_image
docker run --rm --network argus_argus-private \
  --entrypoint node "$argus_vps_cli_image" \
  --input-type=module \
  --eval \
  'const response = await fetch("http://searxng:8080/search?q=argus&format=json"); if (!response.ok) process.exit(1); const body = await response.json(); if (!Array.isArray(body.results)) process.exit(1); process.stdout.write(JSON.stringify(body));' \
  > "$argus_vps_searxng"
jq -e '.results | type == "array"' "$argus_vps_searxng" >/dev/null

docker ps \
  --filter label=com.docker.compose.project=argus \
  --format '{{json .}}' |
  jq -s -e '
    length >= 2 and
    ([.[].Ports // "" | scan("([0-9]+)->"; "g") | .[0]] | unique) == ["8788"]
  ' >/dev/null

printf '%s\n' \
  "Argus clean-VPS smoke passed on $(. /etc/os-release && printf '%s %s' "$ID" "$VERSION_ID")."
