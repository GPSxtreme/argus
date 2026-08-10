import type { CommandResult } from "./contracts.js";
import type { CommandExecutor } from "./executor.js";

const gibibyte = 1024 ** 3;
const minimumDiskBytes = 5 * gibibyte;

export interface PreflightReport {
  supported: boolean;
  os: { id: string; version: string; arch: string };
  docker: { installed: boolean; compose: boolean; daemonReachable: boolean };
  resources: { memoryBytes: number | undefined; diskFreeBytes: number | undefined };
  ports: Array<{ port: number; available: boolean | "unknown" }>;
  failures: Array<{ code: string; message: string; recovery: string }>;
}

export interface InspectHostOptions {
  apiPort?: number;
  managedComposeProject?: string;
  searxngEnabled?: boolean;
  hostArchitecture?: string;
  hostPaths?: {
    osRelease: string;
    meminfo: string;
    diskRoot: string;
  };
}

interface ParsedOsRelease {
  id: string;
  version: string;
}

export const parseOsRelease = (stdout: string): ParsedOsRelease => {
  const values = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).replace(/^(?:"|')|(?:"|')$/g, "");
    values.set(key, value);
  }
  return {
    id: values.get("ID")?.toLowerCase() || "unknown",
    version: values.get("VERSION_ID") || "unknown",
  };
};

export const parseArchitecture = (stdout: string): string => {
  const observed = stdout.trim().toLowerCase();
  switch (observed) {
    case "x86_64":
    case "amd64":
      return "x64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      return observed || "unknown";
  }
};

export const parseMemoryBytes = (stdout: string): number | undefined => {
  const free = stdout.match(/^Mem:\s+(\d+)/m);
  if (free !== null) return Number(free[1]);
  const proc = stdout.match(/^MemTotal:\s+(\d+)\s+kB$/m);
  return proc === null ? undefined : Number(proc[1]) * 1024;
};

export const parseDiskFreeBytes = (stdout: string): number | undefined => {
  const line = stdout.split("\n").find((entry) => entry.trim().length > 0 && !entry.startsWith("Filesystem"));
  if (line === undefined) return undefined;
  const fields = line.trim().split(/\s+/);
  const available = Number(fields[3]);
  return Number.isFinite(available) ? available : undefined;
};

export const parseListeningPorts = (stdout: string): ReadonlySet<number> | undefined => {
  const ports = new Set<number>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("State ")) continue;
    const localAddress = trimmed.split(/\s+/)[3];
    const match = localAddress?.match(/:(\d+)$/);
    if (!match) return undefined;
    ports.add(Number(match[1]));
  }
  return ports;
};

const succeeded = (result: CommandResult): boolean => result.exitCode === 0;

const hasPublishedHostPort = (stdout: string, apiPort: number): boolean => {
  try {
    return stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .some((line) => {
        const ports = JSON.parse(line) as unknown;
        if (ports === null || typeof ports !== "object" || Array.isArray(ports)) {
          return false;
        }
        return Object.values(ports).some(
          (bindings) =>
            Array.isArray(bindings) &&
            bindings.some(
              (binding) =>
                binding !== null &&
                typeof binding === "object" &&
                "HostPort" in binding &&
                binding.HostPort === String(apiPort),
            ),
        );
      });
  } catch {
    return false;
  }
};

const failure = (code: string, message: string, recovery: string) => ({ code, message, recovery });

export const inspectHost = async (
  executor: CommandExecutor,
  options: InspectHostOptions = {},
): Promise<PreflightReport> => {
  const apiPort = options.apiPort ?? 8788;
  const hostPaths = options.hostPaths ?? {
    osRelease: "/etc/os-release",
    meminfo: "/proc/meminfo",
    diskRoot: "/",
  };
  const [osRelease, architecture, dockerVersion, composeVersion, dockerInfo, memory, disk, sockets] =
    await Promise.all([
      executor.run("cat", [hostPaths.osRelease]),
      options.hostArchitecture === undefined
        ? executor.run("docker", ["info", "--format", "{{.Architecture}}"])
        : Promise.resolve({
            exitCode: 0,
            stdout: options.hostArchitecture,
            stderr: "",
          }),
      executor.run("docker", ["--version"]),
      executor.run("docker", ["compose", "version"]),
      executor.run("docker", ["info"]),
      executor.run("cat", [hostPaths.meminfo]),
      executor.run("df", ["-B1", hostPaths.diskRoot]),
      executor.run("ss", ["-ltn"]),
    ]);

  const os = parseOsRelease(osRelease.stdout);
  const arch = parseArchitecture(architecture.stdout);
  const supportedOs = os.id === "ubuntu" || os.id === "debian";
  const supportedArchitecture = arch === "x64" || arch === "arm64";
  const installed = succeeded(dockerVersion);
  const compose = installed && succeeded(composeVersion);
  const daemonReachable = installed && succeeded(dockerInfo);
  const memoryBytes = succeeded(memory) ? parseMemoryBytes(memory.stdout) : undefined;
  const diskFreeBytes = succeeded(disk) ? parseDiskFreeBytes(disk.stdout) : undefined;
  const minimumMemoryBytes = (options.searxngEnabled ? 2 : 1) * gibibyte;
  const usedPorts = succeeded(sockets) ? parseListeningPorts(sockets.stdout) : undefined;
  let managedPortOwner = false;
  if (usedPorts?.has(apiPort) && options.managedComposeProject !== undefined) {
    const containers = await executor.run("docker", [
      "ps",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${options.managedComposeProject}`,
      "--filter",
      "label=com.docker.compose.service=argus",
    ]);
    const containerIds = containers.stdout.trim().split(/\s+/).filter(Boolean);
    if (succeeded(containers) && containerIds.length > 0) {
      const bindings = await executor.run("docker", [
        "inspect",
        "--format",
        "{{json .NetworkSettings.Ports}}",
        ...containerIds,
      ]);
      managedPortOwner =
        succeeded(bindings) && hasPublishedHostPort(bindings.stdout, apiPort);
    }
  }
  const portAvailable =
    usedPorts === undefined
      ? "unknown"
      : !usedPorts.has(apiPort) || managedPortOwner;
  const failures: PreflightReport["failures"] = [];

  if (!supportedOs) {
    failures.push(
      failure(
        "UNSUPPORTED_OS",
        "Argus VPS onboarding supports Ubuntu and Debian hosts only.",
        "Use an Ubuntu or Debian Linux VPS, then run argus onboard again.",
      ),
    );
  }
  if (!supportedArchitecture) {
    failures.push(
      failure(
        "UNSUPPORTED_ARCH",
        "Argus VPS onboarding supports Linux x64 and arm64 hosts only.",
        "Use a Linux x64 or arm64 VPS, then run argus onboard again.",
      ),
    );
  }
  if (!installed) {
    failures.push(
      failure(
        "DOCKER_NOT_INSTALLED",
        "Docker is not available on this host.",
        "Install Docker, then run argus onboard again.",
      ),
    );
  }
  if (!compose) {
    failures.push(
      failure(
        "DOCKER_COMPOSE_UNAVAILABLE",
        "Docker Compose is not available on this host.",
        "Install the Docker Compose plugin, then run argus onboard again.",
      ),
    );
  }
  if (!daemonReachable) {
    failures.push(
      failure(
        "DOCKER_DAEMON_UNREACHABLE",
        "The Docker daemon is not reachable.",
        "Start Docker and confirm this user can access it, then run argus onboard again.",
      ),
    );
  }
  if (memoryBytes === undefined) {
    failures.push(
      failure(
        "MEMORY_INSPECTION_FAILED",
        "Host memory could not be inspected.",
        "Confirm the host memory inspection command is available, then run argus onboard again.",
      ),
    );
  } else if (memoryBytes < minimumMemoryBytes) {
    failures.push(
      failure(
        "INSUFFICIENT_MEMORY",
        "This host does not meet the minimum memory recommendation.",
        `Provide at least ${options.searxngEnabled ? "2" : "1"} GiB of memory, then run argus onboard again.`,
      ),
    );
  }
  if (diskFreeBytes === undefined) {
    failures.push(
      failure(
        "DISK_INSPECTION_FAILED",
        "Host free disk space could not be inspected.",
        "Confirm the host disk inspection command is available, then run argus onboard again.",
      ),
    );
  } else if (diskFreeBytes < minimumDiskBytes) {
    failures.push(
      failure(
        "INSUFFICIENT_DISK",
        "This host does not meet the minimum free disk recommendation.",
        "Free or provide at least 5 GiB of disk space, then run argus onboard again.",
      ),
    );
  }
  if (portAvailable === "unknown") {
    failures.push(
      failure(
        "PORT_INSPECTION_FAILED",
        "Listening ports could not be inspected.",
        "Confirm the socket inspection command is available, then run argus onboard again.",
      ),
    );
  } else if (!portAvailable) {
    failures.push(
      failure(
        "PORT_IN_USE",
        `The API port ${apiPort} is already in use.`,
        "Choose another API port or stop the service using this port, then run argus onboard again.",
      ),
    );
  }

  return {
    supported: supportedOs && supportedArchitecture,
    os: { id: os.id, version: os.version, arch },
    docker: { installed, compose, daemonReachable },
    resources: { memoryBytes, diskFreeBytes },
    ports: [{ port: apiPort, available: portAvailable }],
    failures,
  };
};
