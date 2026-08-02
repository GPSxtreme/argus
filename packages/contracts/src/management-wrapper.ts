/**
 * The complete host boundary granted to the digest-pinned management image.
 *
 * Keep this contract data-only so both the CLI and release renderer can consume
 * the same object without creating a package dependency cycle.
 */
export const MANAGEMENT_WRAPPER_REQUIREMENTS = {
  dockerConfig: "/opt/argus/.docker",
  mounts: [
    "/etc/os-release:/host/etc/os-release:ro",
    "/proc/meminfo:/host/proc/meminfo:ro",
    "/opt/argus:/opt/argus:rw",
    "/var/run/docker.sock:/var/run/docker.sock:rw",
  ],
  environment: [
    "ARGUS_INSTALL_ROOT=/opt/argus",
    "ARGUS_HOST_ARCH",
    "ARGUS_VERSION",
    "DOCKER_CONFIG=/opt/argus/.docker",
  ],
  cliImagePackages: ["iproute2"],
  compositionRoot: [
    "ProductionOnboardingIntegration",
    "InstalledConfigIntegration",
  ],
  hostNetwork: true,
} as const;
