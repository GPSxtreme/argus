#!/bin/sh
set -eu

argus_die() {
  printf '%s\n' "argus installer smoke: $*" >&2
  exit 1
}

argus_required() {
  eval "argus_value=\${$1:-}"
  [ -n "$argus_value" ] || argus_die "$1 is required"
}

for argus_name in \
  ARGUS_INSTALLER_URL \
  ARGUS_MANIFEST_URL \
  ARGUS_EXPECTED_VERSION \
  ARGUS_EXPECTED_WRAPPER_SHA256
do
  argus_required "$argus_name"
done

[ "$(id -u)" -eq 0 ] ||
  argus_die "run this clean-host smoke as root inside an isolated test host"
if [ -e /usr/local/bin/argus ] ||
  [ -e /opt/argus/state.json ] ||
  [ -e /opt/argus/secrets.env ] ||
  [ -e /opt/argus/compose.yaml ]
then
  argus_die "refusing non-clean host with an existing Argus installation"
fi
printf '%s\n' "$ARGUS_EXPECTED_VERSION" |
  grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$' ||
  argus_die "ARGUS_EXPECTED_VERSION must be normalized SemVer"
printf '%s\n' "$ARGUS_EXPECTED_WRAPPER_SHA256" |
  grep -Eq '^[a-f0-9]{64}$' ||
  argus_die "ARGUS_EXPECTED_WRAPPER_SHA256 must be lowercase SHA-256"

for argus_command in curl expect jq openssl sha256sum; do
  command -v "$argus_command" >/dev/null 2>&1 ||
    argus_die "$argus_command is required"
done

argus_artifacts=${ARGUS_SMOKE_ARTIFACT_DIR:-/tmp/argus-installer-smoke}
argus_work=$(mktemp -d "${TMPDIR:-/tmp}/argus-installer-smoke.XXXXXX")
argus_installer=$argus_work/install.sh
argus_first_wrapper=$argus_work/argus.first
argus_answers=/opt/argus/.installer-smoke-onboard.yaml
argus_expect=$argus_work/onboard.exp
argus_doctor=$argus_work/doctor.json
argus_token=
mkdir -p "$argus_artifacts"
chmod 700 "$argus_artifacts"
: > "$argus_artifacts/installer.log"
: > "$argus_artifacts/compose.log"
: > "$argus_artifacts/doctor.json"
: > "$argus_artifacts/wrapper.sha256"
chmod 600 "$argus_artifacts"/*

argus_sanitize() {
  if [ -n "$argus_token" ]; then
    sed "s/$argus_token/[REDACTED]/g"
  else
    cat
  fi
}

argus_collect_failure() {
  argus_status=$?
  if [ "$argus_status" -ne 0 ] && command -v docker >/dev/null 2>&1; then
    docker compose -p argus -f /opt/argus/compose.yaml \
      logs --no-color --tail 200 2>&1 |
      argus_sanitize > "$argus_artifacts/compose.log" || true
  fi
  if [ -f "$argus_doctor" ]; then
    argus_sanitize < "$argus_doctor" > "$argus_artifacts/doctor.json"
  fi
  if [ -n "$argus_token" ] &&
    grep -R -F "$argus_token" \
      "$argus_artifacts/installer.log" \
      "$argus_artifacts/compose.log" \
      "$argus_artifacts/doctor.json" \
      "$argus_artifacts/wrapper.sha256" >/dev/null 2>&1
  then
    : > "$argus_artifacts/installer.log"
    : > "$argus_artifacts/compose.log"
    : > "$argus_artifacts/doctor.json"
    : > "$argus_artifacts/wrapper.sha256"
    argus_status=1
  fi
  rm -f "$argus_answers"
  rm -rf "$argus_work"
  exit "$argus_status"
}
trap argus_collect_failure EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

case "$ARGUS_INSTALLER_URL" in
  https://*)
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      --connect-timeout 10 --max-time 60 --retry 3 --retry-all-errors \
      --output "$argus_installer" "$ARGUS_INSTALLER_URL"
    ;;
  http://127.0.0.1:*|http://localhost:*)
    [ "${ARGUS_INSTALL_FIXTURE:-0}" = 1 ] ||
      argus_die "loopback installer URLs require ARGUS_INSTALL_FIXTURE=1"
    curl --fail --silent --show-error --location --proto '=http' \
      --connect-timeout 10 --max-time 60 --retry 3 --retry-all-errors \
      --output "$argus_installer" "$ARGUS_INSTALLER_URL"
    ;;
  *) argus_die "ARGUS_INSTALLER_URL must use HTTPS or explicit loopback fixture HTTP" ;;
esac
sh -n "$argus_installer"
chmod 700 "$argus_installer"

export ARGUS_MANIFEST_URL ARGUS_EXPECTED_VERSION
export ARGUS_VERSION="$ARGUS_EXPECTED_VERSION"
export ARGUS_INSTALL_DOCKER="${ARGUS_INSTALL_DOCKER:-0}"

sh "$argus_installer" >> "$argus_artifacts/installer.log" 2>&1
printf '%s  %s\n' "$ARGUS_EXPECTED_WRAPPER_SHA256" /usr/local/bin/argus |
  sha256sum --check --strict
[ "$(/usr/local/bin/argus --version)" = "$ARGUS_EXPECTED_VERSION" ] ||
  argus_die "first installation reported the wrong release version"
cp /usr/local/bin/argus "$argus_first_wrapper"

sh "$argus_installer" >> "$argus_artifacts/installer.log" 2>&1
printf '%s  %s\n' "$ARGUS_EXPECTED_WRAPPER_SHA256" /usr/local/bin/argus |
  sha256sum --check --strict
cmp -s "$argus_first_wrapper" /usr/local/bin/argus ||
  argus_die "second installation changed the exact signed wrapper"
[ "$(/usr/local/bin/argus --version)" = "$ARGUS_EXPECTED_VERSION" ] ||
  argus_die "second installation reported the wrong release version"
printf '%s  %s\n' "$ARGUS_EXPECTED_WRAPPER_SHA256" /usr/local/bin/argus \
  > "$argus_artifacts/wrapper.sha256"

cat > "$argus_answers" <<'ARGUS_ONBOARDING'
version: 1
deployment:
  provider: vps-docker
  root: /opt/argus
  storage: sqlite
  apiHost: 0.0.0.0
  apiPort: 8788
managed:
  searxng: disabled
  fxembed: disabled
watches:
  - id: smoke-web
    enabled: true
    schedule: "*/5 * * * *"
    x:
      accounts: []
      queries: []
    telegram:
      channels: []
    web:
      urls: [https://example.com/]
      feeds: []
      queries: []
    keywords: []
intelligence:
  enabled: false
  model: openai/gpt-4.1-mini
ARGUS_ONBOARDING
chmod 600 "$argus_answers"

# This credential exists only for the disposable smoke instance. Expect gives
# the CLI a TTY while keeping the strict answers file and secret out of logs.
argus_token="argus_fixture_$(openssl rand -hex 24)"
cat > "$argus_expect" <<'ARGUS_EXPECT'
log_user 0
set timeout 600
spawn argus onboard --from "$env(ARGUS_SMOKE_ANSWERS)" --yes --json
expect {
  -re {Argus API token} { send -- "$env(ARGUS_SMOKE_TOKEN)\r"; exp_continue }
  eof
  timeout { exit 124 }
}
set result [wait]
exit [lindex $result 3]
ARGUS_EXPECT
chmod 600 "$argus_expect"
ARGUS_SMOKE_ANSWERS=$argus_answers ARGUS_SMOKE_TOKEN=$argus_token \
  expect "$argus_expect"

jq -e --arg version "$ARGUS_EXPECTED_VERSION" \
  '.argusVersion == $version' /opt/argus/state.json >/dev/null
argus doctor --json > "$argus_doctor"
jq -e \
  '.contractVersion == 1 and .ok == true and .data.healthy == true' \
  "$argus_doctor" >/dev/null
argus_sanitize < "$argus_doctor" > "$argus_artifacts/doctor.json"

printf '%s\n' \
  "Argus installer smoke passed for release $ARGUS_EXPECTED_VERSION."
