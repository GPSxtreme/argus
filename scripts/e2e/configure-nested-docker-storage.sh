#!/bin/sh
set -eu

argus_nested_die() {
  printf '%s\n' "argus nested Docker fixture: $*" >&2
  exit 1
}

case "${1:-}" in
  present)
    exit 0
    ;;
  absent) ;;
  *)
    argus_nested_die "mode must be present or absent"
    ;;
esac

argus_nested_root=${ARGUS_NESTED_DOCKER_ROOT:-}
if [ -n "$argus_nested_root" ]; then
  [ "${ARGUS_INSTALL_FIXTURE:-0}" = 1 ] ||
    argus_nested_die "ARGUS_NESTED_DOCKER_ROOT is restricted to explicit fixtures"
  case "$argus_nested_root" in
    /*) ;;
    *) argus_nested_die "ARGUS_NESTED_DOCKER_ROOT must be absolute" ;;
  esac
  [ -d "$argus_nested_root" ] && [ ! -L "$argus_nested_root" ] ||
    argus_nested_die "fixture root must be a real directory"
  argus_nested_root=${argus_nested_root%/}
elif [ "$(id -u)" -ne 0 ]; then
  argus_nested_die "run as root inside the disposable clean host"
fi

argus_nested_etc="${argus_nested_root}/etc"
argus_nested_docker="$argus_nested_etc/docker"
argus_nested_config="$argus_nested_docker/daemon.json"
[ ! -L "$argus_nested_etc" ] && [ ! -L "$argus_nested_docker" ] &&
  [ ! -L "$argus_nested_config" ] ||
  argus_nested_die "refusing a symlinked Docker daemon configuration path"

install -d -m 0755 "$argus_nested_docker"
argus_nested_expected=$(mktemp "${TMPDIR:-/tmp}/argus-nested-docker.XXXXXX")
argus_nested_staged=
argus_nested_cleanup() {
  rm -f -- "$argus_nested_expected"
  if [ -n "$argus_nested_staged" ]; then
    rm -f -- "$argus_nested_staged"
  fi
}
trap argus_nested_cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s\n' '{"storage-driver":"vfs"}' > "$argus_nested_expected"

if [ -e "$argus_nested_config" ]; then
  [ -f "$argus_nested_config" ] &&
    cmp -s "$argus_nested_expected" "$argus_nested_config" ||
    argus_nested_die "existing Docker daemon configuration is not the expected nested-host vfs config"
  exit 0
fi

argus_nested_staged=$(mktemp "$argus_nested_docker/.daemon.json.XXXXXX")
install -m 0644 "$argus_nested_expected" "$argus_nested_staged"
mv -- "$argus_nested_staged" "$argus_nested_config"
argus_nested_staged=
