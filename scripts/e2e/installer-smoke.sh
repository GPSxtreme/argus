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
argus_system_root=${ARGUS_SMOKE_SYSTEM_ROOT:-}
if [ -n "$argus_system_root" ]; then
  [ "${ARGUS_INSTALL_FIXTURE:-0}" = 1 ] ||
    argus_die "ARGUS_SMOKE_SYSTEM_ROOT is restricted to explicit fixtures"
  [ "${argus_system_root#/}" != "$argus_system_root" ] &&
    [ -d "$argus_system_root" ] ||
    argus_die "ARGUS_SMOKE_SYSTEM_ROOT must be an absolute directory"
  argus_system_root=${argus_system_root%/}
fi
argus_host_path() {
  printf '%s\n' "${argus_system_root}$1"
}
if [ -e "$(argus_host_path /usr/local/bin/argus)" ] ||
  [ -e "$(argus_host_path /opt/argus/state.json)" ] ||
  [ -e "$(argus_host_path /opt/argus/secrets.env)" ] ||
  [ -e "$(argus_host_path /opt/argus/compose.yaml)" ]
then
  argus_die "refusing non-clean host with an existing Argus installation"
fi
printf '%s\n' "$ARGUS_EXPECTED_VERSION" |
  grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$' ||
  argus_die "ARGUS_EXPECTED_VERSION must be normalized SemVer"
printf '%s\n' "$ARGUS_EXPECTED_WRAPPER_SHA256" |
  grep -Eq '^[a-f0-9]{64}$' ||
  argus_die "ARGUS_EXPECTED_WRAPPER_SHA256 must be lowercase SHA-256"

for argus_command in curl expect jq openssl sha256sum timeout; do
  command -v "$argus_command" >/dev/null 2>&1 ||
    argus_die "$argus_command is required"
done
argus_snapshot_timeout=10
argus_daemon_settle=1
if [ "${ARGUS_INSTALL_FIXTURE:-0}" = 1 ]; then
  argus_snapshot_timeout=${ARGUS_SNAPSHOT_TIMEOUT_SECONDS:-10}
  argus_daemon_settle=${ARGUS_DAEMON_SETTLE_SECONDS:-1}
fi
printf '%s\n' "$argus_snapshot_timeout" "$argus_daemon_settle" |
  grep -Eq '^[0-9]+([.][0-9]+)?$' ||
  argus_die "snapshot timeout and settle interval must be non-negative numbers"

argus_artifacts=${ARGUS_SMOKE_ARTIFACT_DIR:-/tmp/argus-installer-smoke}
argus_work=$(mktemp -d "${TMPDIR:-/tmp}/argus-installer-smoke.XXXXXX")
argus_installer=$argus_work/install.sh
argus_first_wrapper=$argus_work/argus.first
argus_answers=/opt/argus/.installer-smoke-onboard.yaml
argus_expect=$argus_work/onboard.exp
argus_doctor=$argus_work/doctor.json
argus_inspection=$argus_work/inspection.log
argus_snapshot_before=$argus_work/inspect.before
argus_snapshot_after=$argus_work/inspect.after
argus_daemon_snapshot_before=$argus_work/daemon.before
argus_daemon_snapshot_after=$argus_work/daemon.after
argus_daemon_snapshot_probe=$argus_work/daemon.probe
argus_token=
argus_github_headers=
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
  if [ -n "${ARGUS_GITHUB_TOKEN:-}" ] &&
    grep -R -F "$ARGUS_GITHUB_TOKEN" \
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

if [ -n "${ARGUS_GITHUB_TOKEN:-}" ]; then
  printf '%s\n' "$ARGUS_GITHUB_TOKEN" | LC_ALL=C grep -Eq '^[A-Za-z0-9_.~+/=-]+$' ||
    argus_die "ARGUS_GITHUB_TOKEN contains unsafe characters"
  argus_github_headers="$argus_work/github.headers"
  {
    printf 'Authorization: Bearer %s\n' "$ARGUS_GITHUB_TOKEN"
    printf '%s\n' 'X-GitHub-Api-Version: 2022-11-28'
  } > "$argus_github_headers"
  chmod 600 "$argus_github_headers"
fi

case "$ARGUS_INSTALLER_URL" in
  https://*)
    if [ -n "$argus_github_headers" ]; then
      curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
        --connect-timeout 10 --max-time 60 --retry 3 --retry-all-errors \
        --header @"$argus_github_headers" --header 'Accept: application/octet-stream' \
        --output "$argus_installer" "$ARGUS_INSTALLER_URL"
    else
      curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
        --connect-timeout 10 --max-time 60 --retry 3 --retry-all-errors \
        --output "$argus_installer" "$ARGUS_INSTALLER_URL"
    fi
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

export ARGUS_MANIFEST_URL ARGUS_EXPECTED_VERSION ARGUS_GITHUB_TOKEN
export ARGUS_VERSION="$ARGUS_EXPECTED_VERSION"
export ARGUS_INSTALL_DOCKER="${ARGUS_INSTALL_DOCKER:-0}"
export ARGUS_INSTALL_TARGET=/usr/local/bin/argus

argus_snapshot_stat() {
  if argus_snapshot_exec stat -c '%n' "$1" >/dev/null 2>&1; then
    argus_snapshot_exec stat -c 'entry:%n|%F|%a|%u|%g|%s|%Y|%Z' "$1" ||
      return 1
  else
    argus_snapshot_exec stat -f 'entry:%N|%HT|%Lp|%u|%g|%z|%m|%c' "$1" ||
      return 1
  fi
}

argus_snapshot_exec() {
  timeout --signal=TERM --kill-after=1 "$argus_snapshot_timeout" "$@"
}

argus_snapshot_path() {
  argus_snapshot_label=$1
  argus_snapshot_target=$2
  printf 'path:%s\n' "$argus_snapshot_label"
  if [ -d "$argus_snapshot_target" ]; then
    argus_snapshot_list=$(mktemp "$argus_work/snapshot-list.XXXXXX")
    argus_snapshot_sorted=$(mktemp "$argus_work/snapshot-sorted.XXXXXX")
    if ! argus_snapshot_exec find "$argus_snapshot_target" -xdev -print \
      > "$argus_snapshot_list"
    then
      rm -f "$argus_snapshot_list" "$argus_snapshot_sorted"
      return 1
    fi
    if ! argus_snapshot_exec env LC_ALL=C sort "$argus_snapshot_list" \
      > "$argus_snapshot_sorted"
    then
      rm -f "$argus_snapshot_list" "$argus_snapshot_sorted"
      return 1
    fi
    while IFS= read -r argus_snapshot_entry; do
      argus_snapshot_stat "$argus_snapshot_entry" || return 1
      if [ -L "$argus_snapshot_entry" ]; then
        argus_snapshot_link=$(argus_snapshot_exec readlink "$argus_snapshot_entry") ||
          return 1
        printf 'link:%s\n' "$argus_snapshot_link"
        [ ! -f "$argus_snapshot_entry" ] ||
          argus_snapshot_exec sha256sum "$argus_snapshot_entry" ||
          return 1
      elif [ -f "$argus_snapshot_entry" ]; then
        argus_snapshot_exec sha256sum "$argus_snapshot_entry" || return 1
      fi
    done < "$argus_snapshot_sorted"
    rm -f "$argus_snapshot_list" "$argus_snapshot_sorted"
  elif [ -e "$argus_snapshot_target" ] || [ -L "$argus_snapshot_target" ]; then
    argus_snapshot_stat "$argus_snapshot_target" || return 1
    if [ -L "$argus_snapshot_target" ]; then
      argus_snapshot_link=$(argus_snapshot_exec readlink "$argus_snapshot_target") ||
        return 1
      printf 'link:%s\n' "$argus_snapshot_link"
      [ ! -f "$argus_snapshot_target" ] ||
        argus_snapshot_exec sha256sum "$argus_snapshot_target" ||
        return 1
    elif [ -f "$argus_snapshot_target" ]; then
      argus_snapshot_exec sha256sum "$argus_snapshot_target" || return 1
    fi
  else
    printf '%s\n' absent
  fi
}

argus_snapshot_command() {
  argus_snapshot_command_name=$1
  shift
  printf 'command:%s\n' "$argus_snapshot_command_name"
  if command -v "$argus_snapshot_command_name" >/dev/null 2>&1; then
    argus_snapshot_binary=$(command -v "$argus_snapshot_command_name")
    argus_snapshot_path command-binary "$argus_snapshot_binary"
    set +e
    argus_snapshot_exec "$argus_snapshot_command_name" "$@" 2>&1
    argus_snapshot_status=$?
    set -e
    case "$argus_snapshot_status" in
      124|137) return 1 ;;
    esac
    printf 'status:%s\n' "$argus_snapshot_status"
  else
    printf '%s\n' absent
  fi
}

argus_snapshot_host() {
  argus_snapshot_output=$1
  {
    argus_snapshot_path install-root "$(argus_host_path /opt/argus)"
    argus_snapshot_path wrapper "$(argus_host_path /usr/local/bin/argus)"
    argus_snapshot_path apt-sources "$(argus_host_path /etc/apt/sources.list)"
    argus_snapshot_path apt-sources-dir "$(argus_host_path /etc/apt/sources.list.d)"
    argus_snapshot_path apt-keyrings "$(argus_host_path /etc/apt/keyrings)"
    argus_snapshot_path apt-lists "$(argus_host_path /var/lib/apt/lists)"
    argus_snapshot_path apt-cache "$(argus_host_path /var/cache/apt)"
    argus_snapshot_path docker-keyring \
      "$(argus_host_path /usr/share/keyrings/docker-archive-keyring.gpg)"
    argus_snapshot_path docker-config "$(argus_host_path /etc/docker)"
    argus_snapshot_path containerd-config "$(argus_host_path /etc/containerd)"
    argus_snapshot_path dpkg-state "$(argus_host_path /var/lib/dpkg)"
    argus_snapshot_path docker-systemd \
      "$(argus_host_path /etc/systemd/system/docker.service)"
    argus_snapshot_path docker-systemd-overrides \
      "$(argus_host_path /etc/systemd/system/docker.service.d)"
    argus_snapshot_path containerd-systemd \
      "$(argus_host_path /etc/systemd/system/containerd.service)"
    argus_snapshot_path containerd-systemd-overrides \
      "$(argus_host_path /etc/systemd/system/containerd.service.d)"
    argus_snapshot_path vendor-docker-systemd \
      "$(argus_host_path /usr/lib/systemd/system/docker.service)"
    argus_snapshot_path vendor-docker-systemd-overrides \
      "$(argus_host_path /usr/lib/systemd/system/docker.service.d)"
    argus_snapshot_path vendor-containerd-systemd \
      "$(argus_host_path /usr/lib/systemd/system/containerd.service)"
    argus_snapshot_path vendor-containerd-systemd-overrides \
      "$(argus_host_path /usr/lib/systemd/system/containerd.service.d)"
    argus_snapshot_path legacy-docker-systemd \
      "$(argus_host_path /lib/systemd/system/docker.service)"
    argus_snapshot_path legacy-docker-systemd-overrides \
      "$(argus_host_path /lib/systemd/system/docker.service.d)"
    argus_snapshot_path legacy-containerd-systemd \
      "$(argus_host_path /lib/systemd/system/containerd.service)"
    argus_snapshot_path legacy-containerd-systemd-overrides \
      "$(argus_host_path /lib/systemd/system/containerd.service.d)"
    for argus_compose_directory in \
      /usr/local/lib/docker/cli-plugins \
      /usr/local/libexec/docker/cli-plugins \
      /usr/libexec/docker/cli-plugins \
      /usr/lib/docker/cli-plugins \
      /root/.docker/cli-plugins
    do
      argus_snapshot_path compose-plugins \
        "$(argus_host_path "$argus_compose_directory")"
    done
    argus_snapshot_path installer-lock \
      "${ARGUS_INSTALL_LOCK:-$(argus_host_path /tmp/argus-installer.lock)}"
    argus_snapshot_path runtime-lock \
      "$(argus_host_path /run/lock/argus-installer.lock)"
    argus_snapshot_path persistent-lock \
      "$(argus_host_path /var/lock/argus-installer.lock)"
    for argus_temp_root in /tmp /var/tmp; do
      argus_temp_directory=$(argus_host_path "$argus_temp_root")
      if [ -d "$argus_temp_directory" ]; then
        argus_snapshot_exec find "$argus_temp_directory" -mindepth 1 -maxdepth 1 \
          \( -name 'argus-install.*' -o -name 'argus-installer.lock' \) \
          -print |
          argus_snapshot_exec env LC_ALL=C sort |
          while IFS= read -r argus_temp_path; do
            argus_snapshot_path installer-temp "$argus_temp_path"
          done
      fi
    done
    argus_snapshot_command dpkg-query -W \
      "-f=\${binary:Package}\\t\${Version}\\t\${db:Status-Abbrev}\\n"
    argus_snapshot_command apt-mark showmanual
    argus_snapshot_command apt-mark showhold
    argus_snapshot_command docker --version
    argus_snapshot_command docker compose version
    argus_snapshot_command docker info --format \
      '{{.ServerVersion}}|{{.Driver}}|{{.DockerRootDir}}|{{.CgroupDriver}}|{{.OperatingSystem}}|{{.Architecture}}|{{.OSType}}'
    argus_snapshot_command dockerd --version
    argus_snapshot_command containerd --version
    argus_snapshot_command containerd-shim-runc-v2 --version
    argus_snapshot_command runc --version
    argus_snapshot_command systemctl is-active docker.service
    argus_snapshot_command systemctl is-enabled docker.service
    argus_snapshot_command systemctl show docker.service \
      --property=ActiveState,SubState,UnitFileState
    argus_snapshot_command systemctl is-active containerd.service
    argus_snapshot_command systemctl is-enabled containerd.service
    argus_snapshot_command systemctl show containerd.service \
      --property=ActiveState,SubState,UnitFileState
  } > "$argus_snapshot_output"
}

argus_snapshot_daemon_data() {
  argus_daemon_snapshot_output=$1
  {
    argus_snapshot_path docker-data "$(argus_host_path /var/lib/docker)" ||
      return 1
    argus_snapshot_path containerd-data \
      "$(argus_host_path /var/lib/containerd)" ||
      return 1
  } > "$argus_daemon_snapshot_output"
}

argus_wait_for_daemon_quiescence() {
  argus_daemon_stable_output=$1
  argus_daemon_attempt=1
  argus_daemon_have_snapshot=0
  while [ "$argus_daemon_attempt" -le 5 ]; do
    if [ "$argus_daemon_have_snapshot" -eq 1 ]; then
      sleep "$argus_daemon_settle"
    fi
    if argus_snapshot_daemon_data "$argus_daemon_snapshot_probe" 2>/dev/null; then
      if [ "$argus_daemon_have_snapshot" -eq 1 ] &&
        cmp -s "$argus_daemon_stable_output" "$argus_daemon_snapshot_probe"
      then
        return 0
      fi
      cp "$argus_daemon_snapshot_probe" "$argus_daemon_stable_output"
      argus_daemon_have_snapshot=1
    fi
    argus_daemon_attempt=$((argus_daemon_attempt + 1))
  done
  argus_die "Docker daemon data did not reach a stable clean-host snapshot"
}

if [ "${ARGUS_QUIESCENCE_TEST_ONLY:-0}" = 1 ]; then
  argus_wait_for_daemon_quiescence "$argus_daemon_snapshot_before"
  exit 0
fi

argus_snapshot_host "$argus_snapshot_before"
argus_wait_for_daemon_quiescence "$argus_daemon_snapshot_before"
set +e
ARGUS_INSTALL_INSPECT=1 sh "$argus_installer" > "$argus_inspection" 2>&1
argus_inspection_status=$?
set -e
argus_wait_for_daemon_quiescence "$argus_daemon_snapshot_after"
argus_snapshot_host "$argus_snapshot_after"
cat "$argus_inspection" >> "$argus_artifacts/installer.log"
cmp -s "$argus_daemon_snapshot_before" "$argus_daemon_snapshot_after" ||
  argus_die "installer inspection mutated protected host state"
cmp -s "$argus_snapshot_before" "$argus_snapshot_after" ||
  argus_die "installer inspection mutated protected host state"
[ "$argus_inspection_status" -eq 0 ] ||
  argus_die "installer inspection failed"
grep -Fx "  signed manifest: $ARGUS_MANIFEST_URL" "$argus_inspection" >/dev/null ||
  argus_die "installer inspection reported the wrong manifest"
grep -Fx "  target: /usr/local/bin/argus" "$argus_inspection" >/dev/null ||
  argus_die "installer inspection reported the wrong target"
grep -Fx "No files were downloaded or changed." "$argus_inspection" >/dev/null ||
  argus_die "installer inspection did not confirm a mutation-free plan"

ARGUS_INSTALL_INSPECT=0 sh "$argus_installer" >> "$argus_artifacts/installer.log" 2>&1
printf '%s  %s\n' "$ARGUS_EXPECTED_WRAPPER_SHA256" /usr/local/bin/argus |
  sha256sum --check --strict
[ "$(/usr/local/bin/argus --version)" = "$ARGUS_EXPECTED_VERSION" ] ||
  argus_die "first installation reported the wrong release version"
cp /usr/local/bin/argus "$argus_first_wrapper"

ARGUS_INSTALL_INSPECT=0 sh "$argus_installer" >> "$argus_artifacts/installer.log" 2>&1
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
