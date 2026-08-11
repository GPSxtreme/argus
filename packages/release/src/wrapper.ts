import { MANAGEMENT_WRAPPER_REQUIREMENTS } from "@argus/contracts";

const shellLiteral = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

const dockerArguments = (includeTty: boolean): readonly string[] => [
  "--config",
  MANAGEMENT_WRAPPER_REQUIREMENTS.dockerConfig,
  "run",
  "--rm",
  "-i",
  ...(includeTty ? ["-t"] : []),
  "--network",
  "host",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--read-only",
  "--tmpfs",
  "/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777",
  ...MANAGEMENT_WRAPPER_REQUIREMENTS.mounts.flatMap((mount) => [
    "--volume",
    mount,
  ]),
  "--env",
  "ARGUS_INSTALL_ROOT=/opt/argus",
  "--env",
  "ARGUS_HOST_ARCH=$argus_host_arch",
  "--env",
  "ARGUS_VERSION=$argus_version",
  "--env",
  `DOCKER_CONFIG=${MANAGEMENT_WRAPPER_REQUIREMENTS.dockerConfig}`,
];

const renderDockerCommand = (includeTty: boolean): string => {
  const arguments_ = dockerArguments(includeTty);
  return [
    "exec docker",
    ...arguments_.map((argument) => {
      if (argument === "run") return "run";
      if (argument.endsWith("=$argus_host_arch")) {
        return `${shellLiteral(argument.slice(0, -"$argus_host_arch".length))}"$argus_host_arch"`;
      }
      if (argument.endsWith("=$argus_version")) {
        return `${shellLiteral(argument.slice(0, -"$argus_version".length))}"$argus_version"`;
      }
      return shellLiteral(argument);
    }),
    '"$argus_cli_image"',
    '"$@"',
  ].join(" ");
};

export function renderArgusWrapper(): string {
  const commandWithoutTty = renderDockerCommand(false);
  const commandWithTty = renderDockerCommand(true);

  return `#!/bin/sh
# argus-host-wrapper schema=1
# generated-by=@argus/release
set -eu

argus_state_error() {
  printf '%s\\n' 'Argus management state is missing or invalid. Rerun the signed installer.' >&2
  exit 65
}

argus_state=${shellLiteral(MANAGEMENT_WRAPPER_REQUIREMENTS.stateFile)}
[ -f "$argus_state" ] && [ ! -L "$argus_state" ] || argus_state_error
argus_state_mode=$(stat -c '%a' "$argus_state" 2>/dev/null || stat -f '%Lp' "$argus_state" 2>/dev/null || true)
[ "$argus_state_mode" = 644 ] || argus_state_error
[ "$(wc -c < "$argus_state")" -le ${MANAGEMENT_WRAPPER_REQUIREMENTS.maximumStateBytes} ] || argus_state_error
if ! LC_ALL=C tr -d '\\000' < "$argus_state" | cmp -s - "$argus_state"; then
  argus_state_error
fi
exec 3< "$argus_state" || argus_state_error
IFS= read -r argus_schema <&3 || argus_state_error
IFS= read -r argus_version <&3 || argus_state_error
IFS= read -r argus_cli_image <&3 || argus_state_error
argus_extra=''
if IFS= read -r argus_extra <&3 || [ -n "$argus_extra" ]; then
  argus_state_error
fi
exec 3<&-

[ "$argus_schema" = 'schema=${MANAGEMENT_WRAPPER_REQUIREMENTS.stateSchema}' ] || argus_state_error
case "$argus_version" in
  version=*) argus_version=\${argus_version#version=} ;;
  *) argus_state_error ;;
esac
case "$argus_cli_image" in
  cli_image=*) argus_cli_image=\${argus_cli_image#cli_image=} ;;
  *) argus_state_error ;;
esac
if ! printf '%s\\n' "$argus_version" | LC_ALL=C grep -Eq '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(\\.(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$'; then
  argus_state_error
fi
if ! printf '%s\\n' "$argus_cli_image" | LC_ALL=C grep -Eq '^(localhost(:[0-9]{1,5})?|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?|[a-z0-9]([a-z0-9-]*[a-z0-9])?:[0-9]{1,5})/[a-z0-9]+([._-][a-z0-9]+)*(/[a-z0-9]+([._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$'; then
  argus_state_error
fi
[ "$(printf '%s' "$argus_cli_image" | LC_ALL=C wc -c | tr -d ' ')" -le 255 ] || argus_state_error
argus_registry=\${argus_cli_image%%/*}
case "$argus_registry" in
  *:*)
    argus_port=\${argus_registry##*:}
    case "$argus_port" in
      0*|*[!0-9]*|'') argus_state_error ;;
    esac
    [ "$argus_port" -le 65535 ] 2>/dev/null || argus_state_error
    ;;
esac

case "$(uname -m 2>/dev/null || true)" in
  x86_64|amd64) argus_host_arch=amd64 ;;
  aarch64|arm64) argus_host_arch=arm64 ;;
  *)
    printf '%s\\n' 'Argus supports only x86_64/amd64 and aarch64/arm64 Linux hosts.' >&2
    exit 64
    ;;
esac

argus_has_tty=0
if [ -t 1 ]; then
  argus_has_tty=1
fi

argus_quote() {
  case "$1" in
    *[!A-Za-z0-9_./:@%+=,-]*|'')
      printf "'"
      printf '%s' "$1" | sed "s/'/'\\\\\\\\''/g"
      printf "'"
      ;;
    *) printf '%s' "$1" ;;
  esac
}

argus_print_invocation() {
  if [ "$argus_has_tty" -eq 1 ]; then
    set -- --config ${shellLiteral(MANAGEMENT_WRAPPER_REQUIREMENTS.dockerConfig)} run --rm -i -t --network host --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs ${shellLiteral("/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777")} \\
      --volume ${shellLiteral(MANAGEMENT_WRAPPER_REQUIREMENTS.mounts[0])} \\
      --volume ${shellLiteral(MANAGEMENT_WRAPPER_REQUIREMENTS.mounts[1])} \\
      --volume ${shellLiteral(MANAGEMENT_WRAPPER_REQUIREMENTS.mounts[2])} \\
      --volume ${shellLiteral(MANAGEMENT_WRAPPER_REQUIREMENTS.mounts[3])} \\
      --env ${shellLiteral("ARGUS_INSTALL_ROOT=/opt/argus")} \\
      --env "ARGUS_HOST_ARCH=$argus_host_arch" \\
      --env "ARGUS_VERSION=$argus_version" \\
      --env ${shellLiteral(`DOCKER_CONFIG=${MANAGEMENT_WRAPPER_REQUIREMENTS.dockerConfig}`)} \\
      "$argus_cli_image" "$@"
  else
    set -- --config ${shellLiteral(MANAGEMENT_WRAPPER_REQUIREMENTS.dockerConfig)} run --rm -i --network host --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs ${shellLiteral("/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777")} \\
      --volume ${shellLiteral(MANAGEMENT_WRAPPER_REQUIREMENTS.mounts[0])} \\
      --volume ${shellLiteral(MANAGEMENT_WRAPPER_REQUIREMENTS.mounts[1])} \\
      --volume ${shellLiteral(MANAGEMENT_WRAPPER_REQUIREMENTS.mounts[2])} \\
      --volume ${shellLiteral(MANAGEMENT_WRAPPER_REQUIREMENTS.mounts[3])} \\
      --env ${shellLiteral("ARGUS_INSTALL_ROOT=/opt/argus")} \\
      --env "ARGUS_HOST_ARCH=$argus_host_arch" \\
      --env "ARGUS_VERSION=$argus_version" \\
      --env ${shellLiteral(`DOCKER_CONFIG=${MANAGEMENT_WRAPPER_REQUIREMENTS.dockerConfig}`)} \\
      "$argus_cli_image" "$@"
  fi
  printf '%s' docker
  for argus_argument do
    printf ' '
    argus_quote "$argus_argument"
  done
  printf '\\n'
}

case "\${ARGUS_WRAPPER_INSPECT:-0}" in
  1)
    argus_print_invocation "$@"
    exit 0
    ;;
  0|'') ;;
  *)
    printf '%s\\n' 'ARGUS_WRAPPER_INSPECT must be 0 or 1.' >&2
    exit 64
    ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  printf '%s\\n' 'Docker is required. Install Docker Engine, then run Argus again.' >&2
  exit 69
fi
if [ ! -S /var/run/docker.sock ]; then
  printf '%s\\n' 'The Docker socket is unavailable at /var/run/docker.sock. Start Docker and try again.' >&2
  exit 69
fi
if [ ! -r /var/run/docker.sock ] || [ ! -w /var/run/docker.sock ]; then
  printf '%s\\n' 'Argus cannot access /var/run/docker.sock. Run with an account allowed to use Docker.' >&2
  exit 77
fi

if [ "$argus_has_tty" -eq 1 ]; then
  ${commandWithTty}
fi
${commandWithoutTty}
`;
}
