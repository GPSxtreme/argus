import type { CommandResult } from "./contracts.js";
import type { CommandExecutor } from "./executor.js";

const gibibyte = 1024 ** 3;
const minimumDiskBytes = 5 * gibibyte;

export interface PreflightReport {
  supported: boolean;
  os: { id: "ubuntu" | "debian"; version: string; arch: "x64" | "arm64" };
  docker: { installed: boolean; compose: boolean; daemonReachable: boolean };
  resources: { memoryBytes: number; diskFreeBytes: number };
  ports: Array<{ port: number; available: boolean }>;
  failures: Array<{ code: string; message: string; recovery: string }>;
}

export interface InspectHostOptions {
  apiPort?: number;
  searxngEnabled?: boolean;
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
  return { id: values.get("ID")?.toLowerCase() ?? "", version: values.get("VERSION_ID") ?? "" };
};

export const parseArchitecture = (stdout: string): "x64" | "arm64" | undefined => {
  switch (stdout.trim().toLowerCase()) {
    case "x86_64":
    case "amd64":
      return "x64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      return undefined;
  }
};

export const parseMemoryBytes = (stdout: string): number => {
  const match = stdout.match(/^Mem:\s+(\d+)/m);
  return match === null ? 0 : Number(match[1]);
};

export const parseDiskFreeBytes = (stdout: string): number => {
  const line = stdout.split("\n").find((entry) => entry.trim().length > 0 && !entry.startsWith("Filesystem"));
  if (line === undefined) return 0;
  const fields = line.trim().split(/\s+/);
  return Number(fields[3]) || 0;
};

export const parseListeningPorts = (stdout: string): ReadonlySet<number> => {
  const ports = new Set<number>();
  for (const line of stdout.split("\n")) {
    const localAddress = line.trim().split(/\s+/)[3];
    const match = localAddress?.match(/:(\d+)$/);
    if (match) ports.add(Number(match[1]));
  }
  return ports;
};

const succeeded = (result: CommandResult): boolean => result.exitCode === 0;

const failure = (code: string, message: string, recovery: string) => ({ code, message, recovery });

export const inspectHost = async (
  executor: CommandExecutor,
  options: InspectHostOptions = {},
): Promise<PreflightReport> => {
  const apiPort = options.apiPort ?? 8788;
  const [osRelease, architecture, dockerVersion, composeVersion, dockerInfo, memory, disk, sockets] =
    await Promise.all([
      executor.run("cat", ["/etc/os-release"]),
      executor.run("uname", ["-m"]),
      executor.run("docker", ["--version"]),
      executor.run("docker", ["compose", "version"]),
      executor.run("docker", ["info"]),
      executor.run("free", ["-b"]),
      executor.run("df", ["-B1", "/"]),
      executor.run("ss", ["-ltn"]),
    ]);

  const os = parseOsRelease(osRelease.stdout);
  const arch = parseArchitecture(architecture.stdout);
  const supportedOs = os.id === "ubuntu" || os.id === "debian";
  const supportedArchitecture = arch !== undefined;
  const installed = succeeded(dockerVersion);
  const compose = installed && succeeded(composeVersion);
  const daemonReachable = installed && succeeded(dockerInfo);
  const memoryBytes = parseMemoryBytes(memory.stdout);
  const diskFreeBytes = parseDiskFreeBytes(disk.stdout);
  const minimumMemoryBytes = (options.searxngEnabled ? 2 : 1) * gibibyte;
  const usedPorts = parseListeningPorts(sockets.stdout);
  const portAvailable = !usedPorts.has(apiPort);
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
  if (memoryBytes < minimumMemoryBytes) {
    failures.push(
      failure(
        "INSUFFICIENT_MEMORY",
        "This host does not meet the minimum memory recommendation.",
        `Provide at least ${options.searxngEnabled ? "2" : "1"} GiB of memory, then run argus onboard again.`,
      ),
    );
  }
  if (diskFreeBytes < minimumDiskBytes) {
    failures.push(
      failure(
        "INSUFFICIENT_DISK",
        "This host does not meet the minimum free disk recommendation.",
        "Free or provide at least 5 GiB of disk space, then run argus onboard again.",
      ),
    );
  }
  if (!portAvailable) {
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
    os: { id: os.id === "ubuntu" ? "ubuntu" : "debian", version: os.version, arch: arch ?? "x64" },
    docker: { installed, compose, daemonReachable },
    resources: { memoryBytes, diskFreeBytes },
    ports: [{ port: apiPort, available: portAvailable }],
    failures,
  };
};
