import {
  isPinnedImageReference,
  MANAGEMENT_WRAPPER_REQUIREMENTS,
} from "@argus/contracts";

const normalizedVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export interface ArgusWrapperOptions {
  version: string;
  /**
   * The complete credential-free CLI image reference, including its digest.
   *
   * The name is retained from the public renderer contract; a bare digest is
   * intentionally insufficient because the wrapper must not invent a registry.
   */
  cliImageDigest: string;
}

const shellLiteral = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

const dockerArguments = (
  image: string,
  includeTty: boolean,
): readonly string[] => [
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
  image,
];

const renderDockerCommand = (image: string, includeTty: boolean): string => {
  const arguments_ = dockerArguments(image, includeTty);
  return [
    "exec docker",
    ...arguments_.map((argument, index) => {
      if (index === 0 && argument === "run") return "run";
      if (argument.endsWith("=$argus_host_arch")) {
        return `${shellLiteral(argument.slice(0, -"$argus_host_arch".length))}"$argus_host_arch"`;
      }
      if (argument.endsWith("=$argus_version")) {
        return `${shellLiteral(argument.slice(0, -"$argus_version".length))}"$argus_version"`;
      }
      return shellLiteral(argument);
    }),
    '"$@"',
  ].join(" ");
};

export function renderArgusWrapper(options: ArgusWrapperOptions): string {
  if (!normalizedVersionPattern.test(options.version)) {
    throw new TypeError("Argus wrapper version must be full normalized SemVer.");
  }
  if (!isPinnedImageReference(options.cliImageDigest)) {
    throw new TypeError(
      "Argus CLI image must be a credential-free digest-pinned reference.",
    );
  }

  const commandWithoutTty = renderDockerCommand(
    options.cliImageDigest,
    false,
  );
  const commandWithTty = renderDockerCommand(options.cliImageDigest, true);

  return `#!/bin/sh
set -eu

argus_version=${shellLiteral(options.version)}
argus_cli_image=${shellLiteral(options.cliImageDigest)}

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
    set -- run --rm -i -t --network host --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs ${shellLiteral("/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777")} \\
      --volume ${shellLiteral(MANAGEMENT_WRAPPER_REQUIREMENTS.mounts[0])} \\
      --volume ${shellLiteral(MANAGEMENT_WRAPPER_REQUIREMENTS.mounts[1])} \\
      --volume ${shellLiteral(MANAGEMENT_WRAPPER_REQUIREMENTS.mounts[2])} \\
      --volume ${shellLiteral(MANAGEMENT_WRAPPER_REQUIREMENTS.mounts[3])} \\
      --env ${shellLiteral("ARGUS_INSTALL_ROOT=/opt/argus")} \\
      --env "ARGUS_HOST_ARCH=$argus_host_arch" \\
      --env "ARGUS_VERSION=$argus_version" \\
      "$argus_cli_image" "$@"
  else
    set -- run --rm -i --network host --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs ${shellLiteral("/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777")} \\
      --volume ${shellLiteral(MANAGEMENT_WRAPPER_REQUIREMENTS.mounts[0])} \\
      --volume ${shellLiteral(MANAGEMENT_WRAPPER_REQUIREMENTS.mounts[1])} \\
      --volume ${shellLiteral(MANAGEMENT_WRAPPER_REQUIREMENTS.mounts[2])} \\
      --volume ${shellLiteral(MANAGEMENT_WRAPPER_REQUIREMENTS.mounts[3])} \\
      --env ${shellLiteral("ARGUS_INSTALL_ROOT=/opt/argus")} \\
      --env "ARGUS_HOST_ARCH=$argus_host_arch" \\
      --env "ARGUS_VERSION=$argus_version" \\
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
