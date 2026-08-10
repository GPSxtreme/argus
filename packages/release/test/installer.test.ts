import { execFile, spawn } from "node:child_process";
import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseManagementState,
  type ReleaseManifestError,
  type ReleaseManifestV1,
  renderInstaller,
  serializeReleaseManifestCanonical,
  verifyReleaseManifest,
} from "../src/index.js";

const execute = promisify(execFile);
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
});

const digest = "0".repeat(64);
const previousWrapper = `#!/bin/sh
# argus-host-wrapper schema=1
# generated-by=@argus/release
set -eu

argus_version='0.9.0'
argus_cli_image='ghcr.io/gpsxtreme/argus-cli@sha256:${digest}'
# --env 'ARGUS_INSTALL_ROOT=/opt/argus'
printf '%s\\n' 0.9.0
`;

const manifest = (
  wrapperSha: string,
  wrapperUrl = "https://fixture.invalid/wrapper",
): ReleaseManifestV1 => ({
  schemaVersion: 1,
  version: "1.2.3",
  publishedAt: "2026-08-01T00:00:00.000Z",
  images: {
    app: {
      reference: `ghcr.io/gpsxtreme/argus@sha256:${digest}`,
      digest: `sha256:${digest}`,
    },
    cli: {
      reference: `ghcr.io/gpsxtreme/argus-cli@sha256:${digest}`,
      digest: `sha256:${digest}`,
    },
    searxng: {
      reference: `docker.io/searxng/searxng@sha256:${digest}`,
      digest: `sha256:${digest}`,
    },
    postgres: {
      reference: `docker.io/library/postgres@sha256:${digest}`,
      digest: `sha256:${digest}`,
    },
  },
  assets: {
    fxembed: {
      url: "https://fixture.invalid/fxembed.mjs",
      sha256: digest,
      compatibilityDate: "2026-08-01",
    },
    wrapper: { url: wrapperUrl, sha256: wrapperSha },
    installer: { url: "https://fixture.invalid/install.sh", sha256: digest },
    publicKey: { url: "https://fixture.invalid/release-public.pem", sha256: digest },
    fxembedLicense: { url: "https://fixture.invalid/FXEMBED-LICENSE.md", sha256: digest },
    fxembedProvenance: {
      url: "https://fixture.invalid/fxembed-provenance.json",
      sha256: digest,
    },
  },
  minimumStateSchema: 1,
});

interface Fixture {
  root: string;
  installer: string;
  target: string;
  installRoot: string;
  state: string;
  validationState: string;
  wrapper: string;
  privateKey: KeyObject;
  publicKeyPem: string;
  bin: string;
  osRelease: string;
}

const command = async (path: string, body: string): Promise<void> => {
  await writeFile(path, `#!/bin/sh\nset -eu\n${body}`, { mode: 0o755 });
};

const createFixture = async (): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), "argus-installer-test-"));
  const bin = join(root, "bin");
  const target = join(root, "install", "argus");
  const installRoot = join(root, "opt", "argus");
  const state = join(installRoot, "management.state");
  const validationState = join(installRoot, ".management-state.validation");
  const osRelease = join(root, "os-release");
  await mkdir(bin);
  await mkdir(join(root, "install"));
  await mkdir(installRoot, { recursive: true });
  await writeFile(
    osRelease,
    "ID=ubuntu\nVERSION_ID=24.04\nVERSION_CODENAME=noble\n",
  );
  const wrapper = join(root, "wrapper");
  await writeFile(
    wrapper,
    `#!/bin/sh
# argus-host-wrapper schema=1
# generated-by=@argus/release
set -eu

argus_state_error() {
  exit 65
}

argus_state='${state}'
[ -f "$argus_state" ] && [ ! -L "$argus_state" ] || argus_state_error
argus_state_mode=$(stat -c '%a' "$argus_state" 2>/dev/null || stat -f '%Lp' "$argus_state" 2>/dev/null || true)
[ "$argus_state_mode" = 644 ] || exit 65
exec 3< "$argus_state" || exit 65
IFS= read -r argus_schema <&3 || exit 65
IFS= read -r argus_version <&3 || exit 65
IFS= read -r argus_cli_image <&3 || exit 65
argus_extra=''
if IFS= read -r argus_extra <&3 || [ -n "$argus_extra" ]; then exit 65; fi
exec 3<&-
[ "$argus_schema" = schema=1 ] || exit 65
case "$argus_version" in version=*) argus_version=\${argus_version#version=} ;; *) exit 65 ;; esac
case "$argus_cli_image" in cli_image=*) ;; *) exit 65 ;; esac
if [ "\${1:-}" = --version ]; then
  printf '%s\\n' "\${ARGUS_FIXTURE_WRAPPER_VERSION:-$argus_version}"
  exit 0
fi
exit 64
`,
  );
  await command(
    join(bin, "uname"),
    `printf "%s\\n" "\${ARGUS_FIXTURE_ARCH:-x86_64}"`,
  );
  await command(join(bin, "sync"), "exit 0");
  await command(
    join(bin, "sudo"),
    `[ "\${ARGUS_FIXTURE_DOCKER_ROOT_ONLY:-0}" = 1 ] || exit 1
if [ "\${1:-}" = -n ]; then shift; fi
ARGUS_FIXTURE_UNDER_SUDO=1 exec "$@"`,
  );
  await command(
    join(bin, "docker"),
    `printf '%s\\0' "$@" >> "$ARGUS_FIXTURE_DOCKER_ARGV"
case "$*" in
  "info"|"compose version")
    if [ "\${ARGUS_FIXTURE_DOCKER_ROOT_ONLY:-0}" = 1 ] &&
      [ "\${ARGUS_FIXTURE_UNDER_SUDO:-0}" != 1 ]; then exit 1; fi
    exit 0
    ;;
  *" login ghcr.io "*)
    IFS= read -r argus_password
    printf '%s' "$argus_password" > "$ARGUS_FIXTURE_DOCKER_STDIN"
    argus_config=
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --config ]; then argus_config=$2; shift 2; else shift; fi
    done
    mkdir -p "$argus_config"
    printf '%s\\n' '{"auths":{"ghcr.io":{"auth":"fixture"}}}' > "$argus_config/config.json"
    ;;
  *" run "*)
    [ "\${ARGUS_FIXTURE_UNDER_SUDO:-0}" = 1 ] || exit 77
    argus_config=
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --config ]; then argus_config=$2; shift 2; else shift; fi
    done
    [ -r "$argus_config/config.json" ]
    ;;
  *) exit 64 ;;
esac`,
  );
  await command(
    join(bin, "curl"),
    `argus_last=
for argus_item do argus_last=$argus_item; done
case "$argus_last" in
  http://127.0.0.1:*|http://localhost:*) exec /usr/bin/curl "$@" ;;
esac
argus_output=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then argus_output=$2; shift 2; else shift; fi
done
case "$argus_last" in
  https://fixture.invalid/wrapper) cp "$ARGUS_FIXTURE_WRAPPER" "$argus_output" ;;
  https://api.github.com/user) printf '%s\\n' '{"login":"octocat"}' > "$argus_output" ;;
  https://download.docker.com/linux/*/gpg) printf '%s\\n' fixture-key > "$argus_output" ;;
  *) exit 22 ;;
esac`,
  );
  await command(
    join(bin, "sha256sum"),
    `if [ "\${1:-}" != -c ]; then
  exec shasum -a 256 "$@"
fi
IFS=' ' read -r argus_expected argus_file
argus_actual=$(shasum -a 256 "$argus_file" | awk '{print $1}')
[ "$argus_expected" = "$argus_actual" ]`,
  );
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const installer = join(root, "install.sh");
  await writeFile(
    installer,
    renderInstaller({
      manifestUrl: "https://argus.gpsxtre.me/releases/stable/manifest.json",
      publicKeyPem,
    }),
    { mode: 0o755 },
  );
  return {
    root,
    installer,
    target,
    installRoot,
    state,
    validationState,
    wrapper,
    privateKey,
    publicKeyPem,
    bin,
    osRelease,
  };
};

const serveRelease = async (
  fixture: Fixture,
  manifestBytes: Buffer,
  signature: Uint8Array = sign(null, manifestBytes, fixture.privateKey),
): Promise<string> => {
  const server = createServer((request, response) => {
    if (request.url === "/manifest.json") {
      response.end(manifestBytes);
      return;
    }
    if (request.url === "/manifest.sig") {
      response.end(signature);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}/manifest.json`;
};

const runInstaller = async (
  fixture: Fixture,
  manifestBytes: Buffer,
  environment: Record<string, string> = {},
  signature?: Uint8Array,
) => {
  const manifestUrl = await serveRelease(fixture, manifestBytes, signature);
  return execute("sh", [fixture.installer], {
    env: {
      ...process.env,
      PATH: `${fixture.bin}:/opt/homebrew/bin:/usr/bin:/bin`,
      ARGUS_MANIFEST_URL: manifestUrl,
      ARGUS_INSTALL_FIXTURE: "1",
      ARGUS_INSTALL_OS_RELEASE: fixture.osRelease,
      ARGUS_INSTALL_TARGET: fixture.target,
      ARGUS_INSTALL_ROOT: fixture.installRoot,
      ARGUS_INSTALL_FIXTURE_STATE_PATH: fixture.validationState,
      ARGUS_INSTALL_LOCK: join(fixture.root, "installer.lock"),
      ARGUS_INSTALL_DOCKER: "0",
      ARGUS_FIXTURE_WRAPPER: fixture.wrapper,
      ARGUS_FIXTURE_DOCKER_ARGV: join(fixture.root, "docker.argv"),
      ARGUS_FIXTURE_DOCKER_STDIN: join(fixture.root, "docker.stdin"),
      ...environment,
    },
  });
};

const runInstallerInPty = async (
  fixture: Fixture,
  manifestBytes: Buffer,
  answer: string,
  environment: Record<string, string> = {},
): Promise<{ code: number | null; output: string }> => {
  const manifestUrl = await serveRelease(fixture, manifestBytes);
  const helper = join(fixture.root, "pty_runner.py");
  await writeFile(
    helper,
    `import errno, os, pty, sys
pid, master = pty.fork()
if pid == 0:
    os.execv("/bin/sh", ["sh", sys.argv[1]])
answer = os.environ.get("ARGUS_PTY_ANSWER", "").encode()
os.write(master, answer if answer else b"\\x04")
chunks = []
while True:
    try:
        chunk = os.read(master, 4096)
        if not chunk:
            break
        chunks.append(chunk)
    except OSError as error:
        if error.errno == errno.EIO:
            break
        raise
_, status = os.waitpid(pid, 0)
os.write(1, b"".join(chunks))
sys.exit(os.waitstatus_to_exitcode(status))
`,
  );
  const child = spawn("python3", [helper, fixture.installer], {
    env: {
      ...process.env,
      PATH: `${fixture.bin}:/opt/homebrew/bin:/usr/bin:/bin`,
      ARGUS_MANIFEST_URL: manifestUrl,
      ARGUS_INSTALL_FIXTURE: "1",
      ARGUS_INSTALL_OS_RELEASE: fixture.osRelease,
      ARGUS_INSTALL_TARGET: fixture.target,
      ARGUS_INSTALL_ROOT: fixture.installRoot,
      ARGUS_INSTALL_FIXTURE_STATE_PATH: fixture.validationState,
      ARGUS_INSTALL_LOCK: join(fixture.root, "installer.lock"),
      ARGUS_FIXTURE_WRAPPER: fixture.wrapper,
      ARGUS_PTY_ANSWER: answer,
      ...environment,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  child.stdin.end();
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("PTY installer timed out"));
    }, 15_000);
    child.once("error", reject);
    child.once("exit", (status) => {
      clearTimeout(timer);
      resolve(status);
    });
  });
  return { code, output };
};

describe("renderInstaller", () => {
  it("renders a strict POSIX installer with the supplied trust root", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({
      type: "spki",
      format: "pem",
    }).toString();

    const installer = renderInstaller({
      manifestUrl: "https://argus.gpsxtre.me/releases/stable/manifest.json",
      publicKeyPem,
    });

    expect(installer).toMatch(/^#!\/bin\/sh\nset -eu\n/);
    expect(installer).toContain(publicKeyPem.trim());
    expect(installer).toContain("openssl pkeyutl -verify");
    expect(installer).toContain("IFS= read -r argus_answer <&3");
    expect(installer).toContain("Docker installation declined");
    expect(installer).toContain("--connect-timeout 10 --max-time 60 --retry 3");
    expect(installer).toContain("ARGUS_GITHUB_TOKEN");
    expect(installer).toContain("grep -Eq '^[!-~]+$'");
    expect(installer).toContain("wc -l");
    expect(installer).toContain("https://api.github.com/repos/");
    expect(installer).toContain("application/octet-stream");
    expect(installer).toContain("GitHub token requires jq");
    expect(installer).toContain('--header @"$argus_github_headers"');
    expect(installer).not.toContain(
      '--header "Authorization: Bearer $ARGUS_GITHUB_TOKEN"',
    );
    expect(installer).not.toContain("eval ");
    expect(installer).not.toContain(". /etc/os-release");
    expect(installer).toContain("argus onboard");
  });

  it.each([
    "https://argus.gpsxtre.me/releases/manifest.json",
    "https://releases.example.com:443/v1/manifest.json",
    "https://127.0.0.1:8443/fixture/manifest.json",
  ])("accepts production manifest URL %s", (manifestUrl) => {
    const { publicKey } = generateKeyPairSync("ed25519");
    expect(() =>
      renderInstaller({
        manifestUrl,
        publicKeyPem: publicKey
          .export({ type: "spki", format: "pem" })
          .toString(),
      }),
    ).not.toThrow();
  });

  it.each([
    "https://example.com",
    "https://example.com/",
    "https://example.com:0/manifest.json",
    "https://example.com:65536/manifest.json",
    "https://singlelabel/manifest.json",
    "https://-bad.example/manifest.json",
    "https://bad-.example/manifest.json",
    "https://example.com/manifest path.json",
    "https://example.com/manifest.json?channel=stable",
    "https://user@example.com/manifest.json",
    "http://127.0.0.1:8080/manifest.json",
  ])("rejects non-production manifest URL %s", (manifestUrl) => {
    const { publicKey } = generateKeyPairSync("ed25519");
    expect(() =>
      renderInstaller({
        manifestUrl,
        publicKeyPem: publicKey
          .export({ type: "spki", format: "pem" })
          .toString(),
      }),
    ).toThrow("credential-free HTTPS");
  });

  it("bootstraps a verified management state and exact durable launcher idempotently", async () => {
    const fixture = await createFixture();
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");
    const bytes = Buffer.from(JSON.stringify(manifest(wrapperSha)));

    const first = await runInstaller(fixture, bytes);
    expect(first.stdout).toBe("argus onboard\n");
    expect((await lstat(fixture.target)).mode & 0o777).toBe(0o755);
    expect((await lstat(fixture.state)).mode & 0o777).toBe(0o644);
    expect(parseManagementState(await readFile(fixture.state, "utf8"))).toEqual({
      schema: 1,
      version: "1.2.3",
      cliImage: `ghcr.io/gpsxtreme/argus-cli@sha256:${digest}`,
    });
    const installed = await readFile(fixture.target);
    const installedState = await readFile(fixture.state);
    expect(createHash("sha256").update(installed).digest("hex")).toBe(wrapperSha);
    const second = await runInstaller(fixture, bytes);
    expect(second.stdout).toBe("argus onboard\n");
    expect(await readFile(fixture.target)).toEqual(installed);
    expect(await readFile(fixture.state)).toEqual(installedState);
    await expect(lstat(fixture.validationState)).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 15_000);

  it("shares the exact canonical manifest corpus with the Node verifier", async () => {
    const fixture = await createFixture();
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");
    const canonical = Buffer.from(
      serializeReleaseManifestCanonical(manifest(wrapperSha)),
    );
    const canonicalSignature = sign(null, canonical, fixture.privateKey);
    expect(
      verifyReleaseManifest(
        canonical,
        canonicalSignature,
        fixture.publicKeyPem,
      ),
    ).toEqual(manifest(wrapperSha));
    await expect(runInstaller(fixture, canonical)).resolves.toMatchObject({
      stdout: "argus onboard\n",
    });

    const value = manifest(wrapperSha);
    const { version: reorderedVersion, ...reorderedRest } = value;
    const variants = [
      Buffer.concat([Buffer.from(" "), canonical]),
      Buffer.concat([canonical, Buffer.from("\n")]),
      Buffer.concat([Buffer.from("\uFEFF"), canonical]),
      Buffer.from(JSON.stringify({ version: reorderedVersion, ...reorderedRest })),
    ];
    for (const noncanonical of variants) {
      const second = await createFixture();
      const noncanonicalSignature = sign(null, noncanonical, second.privateKey);
      expect(() =>
        verifyReleaseManifest(
          noncanonical,
          noncanonicalSignature,
          second.publicKeyPem,
        ),
      ).toThrowError(
        expect.objectContaining<Partial<ReleaseManifestError>>({
          code: "RELEASE_MANIFEST_NON_CANONICAL",
        }),
      );
      await expect(runInstaller(second, noncanonical)).rejects.toBeDefined();
    }
  }, 15_000);

  it("rejects the same canonical-looking invalid URL and image corpus in Node and shell", async () => {
    const fixture = await createFixture();
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");
    const base = manifest(wrapperSha);
    const pinned = (name: string) => `${name}@sha256:${digest}`;
    const longRepository = `ghcr.io/${"a".repeat(120)}/${"b".repeat(120)}`;
    const variants: unknown[] = [
      {
        ...base,
        assets: {
          ...base.assets,
          wrapper: { ...base.assets.wrapper, url: "https://example.com" },
        },
      },
      {
        ...base,
        assets: {
          ...base.assets,
          wrapper: { ...base.assets.wrapper, url: "https://example.com:0/argus" },
        },
      },
      {
        ...base,
        assets: {
          ...base.assets,
          wrapper: {
            ...base.assets.wrapper,
            url: "https://example.com:65536/argus",
          },
        },
      },
      {
        ...base,
        images: {
          ...base.images,
          app: { ...base.images.app, reference: pinned("ghcr.io/team//argus") },
        },
      },
      {
        ...base,
        images: {
          ...base.images,
          app: {
            ...base.images.app,
            reference: pinned("registry.example:0/team/argus"),
          },
        },
      },
      {
        ...base,
        images: {
          ...base.images,
          app: {
            ...base.images.app,
            reference: pinned("registry.example:65536/team/argus"),
          },
        },
      },
      {
        ...base,
        images: {
          ...base.images,
          app: { ...base.images.app, reference: pinned("registry/team/argus") },
        },
      },
      {
        ...base,
        images: {
          ...base.images,
          app: { ...base.images.app, reference: pinned("ghcr.io/team/bad..repo") },
        },
      },
      {
        ...base,
        images: {
          ...base.images,
          app: { ...base.images.app, reference: pinned(longRepository) },
        },
      },
      {
        ...base,
        images: {
          ...base.images,
          app: { ...base.images.app, digest: `sha256:${"1".repeat(64)}` },
        },
      },
    ];
    for (const value of variants) {
      const invalidFixture = await createFixture();
      const bytes = Buffer.from(JSON.stringify(value));
      const signature = sign(null, bytes, invalidFixture.privateKey);
      try {
        verifyReleaseManifest(bytes, signature, invalidFixture.publicKeyPem);
        throw new Error("Node verifier accepted invalid corpus entry");
      } catch (error) {
        expect((error as ReleaseManifestError).code).toBe(
          "RELEASE_MANIFEST_SCHEMA_INVALID",
        );
      }
      await expect(runInstaller(invalidFixture, bytes)).rejects.toBeDefined();
    }
  }, 30_000);

  it.each([
    "localhost/team/argus",
    "localhost:5000/team/argus",
    "registry:5000/team/argus",
    "registry.example/team_name/argus-v1",
  ])("accepts shared canonical pinned-image form %s", async (name) => {
    const fixture = await createFixture();
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");
    const value = manifest(wrapperSha);
    value.images.app.reference = `${name}@${value.images.app.digest}`;
    const bytes = Buffer.from(serializeReleaseManifestCanonical(value));
    const signature = sign(null, bytes, fixture.privateKey);
    expect(
      verifyReleaseManifest(bytes, signature, fixture.publicKeyPem),
    ).toEqual(value);
    await expect(runInstaller(fixture, bytes)).resolves.toMatchObject({
      stdout: "argus onboard\n",
    });
  }, 15_000);

  it("rejects a bad signature before trusting manifest fields", async () => {
    const fixture = await createFixture();
    const bytes = Buffer.from(JSON.stringify(manifest(digest)));
    await expect(
      runInstaller(fixture, bytes, {}, Buffer.alloc(64)),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("signature is invalid"),
    });
  });

  it("accepts opaque visible-ASCII GitHub tokens and rejects header injection", async () => {
    const fixture = await createFixture();
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");
    const bytes = Buffer.from(JSON.stringify(manifest(wrapperSha)));

    await expect(
      runInstaller(fixture, bytes, {
        ARGUS_GITHUB_TOKEN: "github_pat:opaque-token.value~+/=",
      }),
    ).resolves.toMatchObject({ stdout: "argus onboard\n" });

    const unsafe = await createFixture();
    await expect(
      runInstaller(unsafe, bytes, {
        ARGUS_GITHUB_TOKEN: "github_pat_safe\nInjected: header",
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "ARGUS_GITHUB_TOKEN contains unsafe characters",
      ),
    });

    const unsafeUser = await createFixture();
    await expect(
      runInstaller(unsafeUser, bytes, {
        ARGUS_GITHUB_TOKEN: "github_pat_safe",
        ARGUS_GITHUB_USER: "octocat\n--password",
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "ARGUS_GITHUB_USER must be a valid GitHub username",
      ),
    });
  });

  it("authenticates private GHCR pulls through stdin and persists only the Docker config", async () => {
    const fixture = await createFixture();
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");
    const bytes = Buffer.from(JSON.stringify(manifest(wrapperSha)));
    const token = "github_pat:opaque-token.value~+/=";

    const first = await runInstaller(fixture, bytes, {
      ARGUS_GITHUB_TOKEN: token,
      ARGUS_GITHUB_USER: "octocat",
    });
    const config = join(fixture.installRoot, ".docker", "config.json");
    const firstConfig = await readFile(config, "utf8");

    expect(first.stdout).not.toContain(token);
    expect(first.stderr).not.toContain(token);
    expect(await readFile(join(fixture.root, "docker.stdin"), "utf8")).toBe(
      token,
    );
    expect(
      await readFile(join(fixture.root, "docker.argv"), "utf8"),
    ).not.toContain(token);
    expect(firstConfig).toContain('"ghcr.io"');
    expect((await lstat(join(fixture.installRoot, ".docker"))).mode & 0o777).toBe(
      0o700,
    );
    expect((await lstat(config)).mode & 0o777).toBe(0o600);

    await expect(
      runInstaller(fixture, bytes, {
        ARGUS_GITHUB_TOKEN: token,
        ARGUS_GITHUB_USER: "octocat",
      }),
    ).resolves.toMatchObject({ stdout: "argus onboard\n" });
    expect(await readFile(config, "utf8")).toBe(firstConfig);
  });

  it("keeps root-mode GHCR credentials readable only to the future root wrapper context", async () => {
    const fixture = await createFixture();
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");
    const bytes = Buffer.from(JSON.stringify(manifest(wrapperSha)));
    const environment = {
      ARGUS_GITHUB_TOKEN: "github_pat:root-context-token",
      ARGUS_GITHUB_USER: "octocat",
      ARGUS_FIXTURE_DOCKER_ROOT_ONLY: "1",
    };

    await expect(runInstaller(fixture, bytes, environment)).resolves.toMatchObject({
      stdout: "argus onboard\n",
    });
    const configDirectory = join(fixture.installRoot, ".docker");
    const config = join(configDirectory, "config.json");
    expect((await lstat(configDirectory)).mode & 0o777).toBe(0o700);
    expect((await lstat(config)).mode & 0o777).toBe(0o600);

    await expect(
      execute(
        join(fixture.bin, "sudo"),
        ["docker", "--config", configDirectory, "run", "fixture"],
        {
          env: {
            ...process.env,
            PATH: `${fixture.bin}:/opt/homebrew/bin:/usr/bin:/bin`,
            ARGUS_FIXTURE_DOCKER_ARGV: join(fixture.root, "docker.argv"),
            ARGUS_FIXTURE_DOCKER_STDIN: join(fixture.root, "docker.stdin"),
            ...environment,
          },
        },
      ),
    ).resolves.toMatchObject({ stdout: "" });
  });

  it("rejects signed duplicate-key JSON and unsafe artifact URLs", async () => {
    const fixture = await createFixture();
    const duplicate = Buffer.from(
      `{"schemaVersion":1,"schemaVersion":1,"version":"1.2.3"}`,
    );
    await expect(runInstaller(fixture, duplicate)).rejects.toMatchObject({
      stderr: expect.stringContaining("canonical schema"),
    });

    const unsafe = Buffer.from(
      JSON.stringify(manifest(digest, "https://user@example.test/wrapper")),
    );
    await expect(runInstaller(fixture, unsafe)).rejects.toMatchObject({
      stderr: expect.stringContaining("canonical schema"),
    });
  });

  it("rejects a checksum mismatch", async () => {
    const fixture = await createFixture();
    const bytes = Buffer.from(JSON.stringify(manifest(digest)));
    await expect(runInstaller(fixture, bytes)).rejects.toMatchObject({
      stderr: expect.stringContaining("checksum"),
    });
  });

  it("preserves an existing wrapper when the replacement version check fails", async () => {
    const fixture = await createFixture();
    await writeFile(
      fixture.target,
      previousWrapper,
      { mode: 0o755 },
    );
    await writeFile(
      fixture.state,
      `schema=1\nversion=0.9.0\ncli_image=ghcr.io/gpsxtreme/argus-cli@sha256:${digest}\n`,
      { mode: 0o644 },
    );
    const original = await readFile(fixture.target);
    const originalState = await readFile(fixture.state, "utf8");
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");
    const bytes = Buffer.from(JSON.stringify(manifest(wrapperSha)));
    await expect(
      runInstaller(fixture, bytes, {
        ARGUS_FIXTURE_WRAPPER_VERSION: "9.9.9",
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("existing installation was preserved"),
    });
    expect(await readFile(fixture.target)).toEqual(original);
    expect(await readFile(fixture.state, "utf8")).toEqual(originalState);
  });

  it.each([7, 8, 9, 10, 11])(
    "restores the complete prior pair when durability sync %d fails",
    async (failureCount) => {
    const fixture = await createFixture();
    await writeFile(fixture.target, previousWrapper, { mode: 0o750 });
    await writeFile(
      fixture.state,
      `schema=1\nversion=0.9.0\ncli_image=ghcr.io/gpsxtreme/argus-cli@sha256:${digest}\n`,
      { mode: 0o600 },
    );
    const originalState = await readFile(fixture.state, "utf8");
    const syncCount = join(fixture.root, "sync-count");
    await command(
      join(fixture.bin, "sync"),
      `argus_count=0
[ ! -f "$ARGUS_SYNC_COUNT" ] || argus_count=$(cat "$ARGUS_SYNC_COUNT")
argus_count=$((argus_count + 1))
printf '%s' "$argus_count" > "$ARGUS_SYNC_COUNT"
[ "$argus_count" -ne "$ARGUS_SYNC_FAIL_AT" ]`,
    );
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");
    await expect(
      runInstaller(
        fixture,
        Buffer.from(JSON.stringify(manifest(wrapperSha))),
        {
          ARGUS_SYNC_COUNT: syncCount,
          ARGUS_SYNC_FAIL_AT: String(failureCount),
        },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("previous state was restored"),
    });
    expect(await readFile(fixture.target, "utf8")).toBe(previousWrapper);
    expect(await readFile(fixture.state, "utf8")).toBe(originalState);
    expect((await lstat(fixture.target)).mode & 0o777).toBe(0o750);
    expect((await lstat(fixture.state)).mode & 0o777).toBe(0o600);
    },
  );

  it("preserves the recovery backup when rollback cannot restore the launcher", async () => {
    const fixture = await createFixture();
    await writeFile(fixture.target, previousWrapper, { mode: 0o750 });
    await writeFile(
      fixture.state,
      `schema=1\nversion=0.9.0\ncli_image=ghcr.io/gpsxtreme/argus-cli@sha256:${digest}\n`,
      { mode: 0o600 },
    );
    const syncCount = join(fixture.root, "sync-count");
    await command(
      join(fixture.bin, "sync"),
      `argus_count=0
[ ! -f "$ARGUS_SYNC_COUNT" ] || argus_count=$(cat "$ARGUS_SYNC_COUNT")
argus_count=$((argus_count + 1))
printf '%s' "$argus_count" > "$ARGUS_SYNC_COUNT"
[ "$argus_count" -ne 8 ]`,
    );
    await command(
      join(fixture.bin, "mv"),
      `argus_source=
argus_destination=
for argus_item do
  argus_destination=$argus_item
  case "$argus_item" in -*) ;; *) [ -n "$argus_source" ] || argus_source=$argus_item ;; esac
done
case "$argus_source" in *.argus.restore.*) exit 1 ;; esac
exec /bin/mv "$@"`,
    );
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");

    await expect(
      runInstaller(fixture, Buffer.from(JSON.stringify(manifest(wrapperSha))), {
        ARGUS_SYNC_COUNT: syncCount,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("recovery backups were preserved"),
    });
    expect(await readdir(join(fixture.root, "install"))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^\.argus\.backup\./u)]),
    );
  });

  it("retains recovery backups when rollback directory sync fails", async () => {
    const fixture = await createFixture();
    await writeFile(fixture.target, previousWrapper, { mode: 0o750 });
    await writeFile(
      fixture.state,
      `schema=1\nversion=0.9.0\ncli_image=ghcr.io/gpsxtreme/argus-cli@sha256:${digest}\n`,
      { mode: 0o600 },
    );
    const syncCount = join(fixture.root, "sync-count");
    await command(
      join(fixture.bin, "sync"),
      `argus_count=0
[ ! -f "$ARGUS_SYNC_COUNT" ] || argus_count=$(cat "$ARGUS_SYNC_COUNT")
argus_count=$((argus_count + 1))
printf '%s' "$argus_count" > "$ARGUS_SYNC_COUNT"
case "$argus_count" in 8|11) exit 1 ;; esac`,
    );
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");

    await expect(
      runInstaller(fixture, Buffer.from(JSON.stringify(manifest(wrapperSha))), {
        ARGUS_SYNC_COUNT: syncCount,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("recovery backups were preserved"),
    });
    expect(await readdir(join(fixture.root, "install"))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^\.argus\.backup\./u)]),
    );
    expect(await readdir(fixture.installRoot)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\.management\.state\.backup\./u),
      ]),
    );
  });

  it("fails closed when a launcher target becomes a symlink during preservation", async () => {
    const fixture = await createFixture();
    await writeFile(fixture.target, previousWrapper, { mode: 0o755 });
    const protectedFile = join(fixture.root, "protected");
    await writeFile(protectedFile, "do-not-follow\n", { mode: 0o600 });
    await command(
      join(fixture.bin, "cp"),
      `argus_source=
for argus_item do
  case "$argus_item" in -*) ;; *) argus_source=$argus_item; break ;; esac
done
if [ "\${ARGUS_FIXTURE_SWAP_TARGET:-0}" = 1 ] && [ "$argus_source" = "$ARGUS_INSTALL_TARGET" ]; then
  ln -sf "$ARGUS_FIXTURE_PROTECTED_FILE" "$ARGUS_INSTALL_TARGET"
fi
exec /bin/cp "$@"`,
    );
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");

    await expect(
      runInstaller(fixture, Buffer.from(JSON.stringify(manifest(wrapperSha))), {
        ARGUS_FIXTURE_SWAP_TARGET: "1",
        ARGUS_FIXTURE_PROTECTED_FILE: protectedFile,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("changed during preservation"),
    });
    expect(await readFile(protectedFile, "utf8")).toBe("do-not-follow\n");
  });

  it("fails closed when the launcher becomes a symlink during promotion", async () => {
    const fixture = await createFixture();
    const protectedWrapper = join(fixture.root, "protected-wrapper");
    await writeFile(protectedWrapper, await readFile(fixture.wrapper), { mode: 0o755 });
    await command(
      join(fixture.bin, "mv"),
      `argus_source=
argus_destination=
for argus_item do
  argus_destination=$argus_item
  case "$argus_item" in -*) ;; *) [ -n "$argus_source" ] || argus_source=$argus_item ;; esac
done
if [ "\${ARGUS_FIXTURE_PROMOTE_TARGET_SYMLINK:-0}" = 1 ] &&
  case "$argus_source" in *.argus.tmp.*) true ;; *) false ;; esac
then
  ln -sf "$ARGUS_FIXTURE_PROTECTED_WRAPPER" "$argus_destination"
  exit 0
fi
exec /bin/mv "$@"`,
    );
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");

    await expect(
      runInstaller(fixture, Buffer.from(JSON.stringify(manifest(wrapperSha))), {
        ARGUS_FIXTURE_PROMOTE_TARGET_SYMLINK: "1",
        ARGUS_FIXTURE_PROTECTED_WRAPPER: protectedWrapper,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("recovery backups were preserved"),
    });
    await expect(lstat(fixture.target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(fixture.root, "install"))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^\.argus\.quarantine\./u)]),
    );
  });

  it("fails closed when the installation root becomes a symlink during promotion", async () => {
    const fixture = await createFixture();
    const alternateRoot = join(fixture.root, "alternate-root");
    const movedRoot = join(fixture.root, "real-install-root");
    await mkdir(alternateRoot);
    await command(
      join(fixture.bin, "mv"),
      `argus_source=
for argus_item do
  case "$argus_item" in -*) ;; *) [ -n "$argus_source" ] || argus_source=$argus_item ;; esac
done
if [ "\${ARGUS_FIXTURE_PROMOTE_ROOT_SYMLINK:-0}" = 1 ] &&
  case "$argus_source" in *.management-state.validation) true ;; *) false ;; esac
then
  /bin/mv "$ARGUS_INSTALL_ROOT" "$ARGUS_FIXTURE_MOVED_ROOT"
  ln -s "$ARGUS_FIXTURE_ALTERNATE_ROOT" "$ARGUS_INSTALL_ROOT"
  /bin/mv "$ARGUS_FIXTURE_MOVED_ROOT/.management-state.validation" "$ARGUS_FIXTURE_ALTERNATE_ROOT/management.state"
  exit 0
fi
exec /bin/mv "$@"`,
    );
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");

    await expect(
      runInstaller(fixture, Buffer.from(JSON.stringify(manifest(wrapperSha))), {
        ARGUS_FIXTURE_PROMOTE_ROOT_SYMLINK: "1",
        ARGUS_FIXTURE_ALTERNATE_ROOT: alternateRoot,
        ARGUS_FIXTURE_MOVED_ROOT: movedRoot,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("recovery backups were preserved"),
    });
    expect((await lstat(fixture.installRoot)).isSymbolicLink()).toBe(true);
  });

  it("fails closed when the management state becomes a symlink during promotion", async () => {
    const fixture = await createFixture();
    const protectedState = join(fixture.root, "protected-state");
    await writeFile(
      protectedState,
      `schema=1\nversion=1.2.3\ncli_image=ghcr.io/gpsxtreme/argus-cli@sha256:${digest}\n`,
      { mode: 0o644 },
    );
    await command(
      join(fixture.bin, "mv"),
      `argus_source=
argus_destination=
for argus_item do
  argus_destination=$argus_item
  case "$argus_item" in -*) ;; *) [ -n "$argus_source" ] || argus_source=$argus_item ;; esac
done
if [ "\${ARGUS_FIXTURE_PROMOTE_STATE_SYMLINK:-0}" = 1 ] &&
  case "$argus_source" in *.management-state.validation) true ;; *) false ;; esac
then
  ln -sf "$ARGUS_FIXTURE_PROTECTED_STATE" "$argus_destination"
  exit 0
fi
exec /bin/mv "$@"`,
    );
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");

    await expect(
      runInstaller(fixture, Buffer.from(JSON.stringify(manifest(wrapperSha))), {
        ARGUS_FIXTURE_PROMOTE_STATE_SYMLINK: "1",
        ARGUS_FIXTURE_PROTECTED_STATE: protectedState,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("recovery backups were preserved"),
    });
    await expect(lstat(fixture.state)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(fixture.installRoot)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\.management\.state\.quarantine\./u),
      ]),
    );
  });

  it("does not remove a concurrent management state when promotion fails before its move", async () => {
    const fixture = await createFixture();
    await command(
      join(fixture.bin, "mv"),
      `argus_source=
argus_destination=
for argus_item do
  argus_destination=$argus_item
  case "$argus_item" in -*) ;; *) [ -n "$argus_source" ] || argus_source=$argus_item ;; esac
done
if [ "\${ARGUS_FIXTURE_CONCURRENT_STATE:-0}" = 1 ] &&
  case "$argus_source" in *.management-state.validation) true ;; *) false ;; esac
then
  printf '%s\\n' concurrent-state > "$argus_destination"
  exit 1
fi
exec /bin/mv "$@"`,
    );
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");

    await expect(
      runInstaller(fixture, Buffer.from(JSON.stringify(manifest(wrapperSha))), {
        ARGUS_FIXTURE_CONCURRENT_STATE: "1",
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("previous state was restored"),
    });
    expect(await readFile(fixture.state, "utf8")).toBe("concurrent-state\n");
  });

  it("does not remove a concurrent launcher when promotion fails before its move", async () => {
    const fixture = await createFixture();
    await command(
      join(fixture.bin, "mv"),
      `argus_source=
argus_destination=
for argus_item do
  argus_destination=$argus_item
  case "$argus_item" in -*) ;; *) [ -n "$argus_source" ] || argus_source=$argus_item ;; esac
done
if [ "\${ARGUS_FIXTURE_CONCURRENT_TARGET:-0}" = 1 ] &&
  case "$argus_source" in *.argus.tmp.*) true ;; *) false ;; esac
then
  printf '%s\\n' concurrent-target > "$argus_destination"
  exit 1
fi
exec /bin/mv "$@"`,
    );
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");

    await expect(
      runInstaller(fixture, Buffer.from(JSON.stringify(manifest(wrapperSha))), {
        ARGUS_FIXTURE_CONCURRENT_TARGET: "1",
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("previous state was restored"),
    });
    expect(await readFile(fixture.target, "utf8")).toBe("concurrent-target\n");
  });

  it.each(["content", "mode"])(
    "fails closed when launcher %s changes in place during preservation",
    async (change) => {
      const fixture = await createFixture();
      await writeFile(fixture.target, previousWrapper, { mode: 0o755 });
      const replacement = join(fixture.root, "replacement-wrapper");
      await writeFile(replacement, previousWrapper.replace("0.9.0", "0.8.0"), {
        mode: 0o755,
      });
      await command(
        join(fixture.bin, "cp"),
        `argus_source=
for argus_item do
  case "$argus_item" in -*) ;; *) argus_source=$argus_item; break ;; esac
done
if [ "$argus_source" = "$ARGUS_INSTALL_TARGET" ] && [ "\${ARGUS_FIXTURE_CHANGE:-}" = content ]; then
  /bin/cp "$ARGUS_FIXTURE_REPLACEMENT_WRAPPER" "$ARGUS_INSTALL_TARGET"
elif [ "$argus_source" = "$ARGUS_INSTALL_TARGET" ] && [ "\${ARGUS_FIXTURE_CHANGE:-}" = mode ]; then
  chmod 700 "$ARGUS_INSTALL_TARGET"
fi
exec /bin/cp "$@"`,
      );
      const wrapperSha = createHash("sha256")
        .update(await readFile(fixture.wrapper))
        .digest("hex");

      await expect(
        runInstaller(fixture, Buffer.from(JSON.stringify(manifest(wrapperSha))), {
          ARGUS_FIXTURE_CHANGE: change,
          ARGUS_FIXTURE_REPLACEMENT_WRAPPER: replacement,
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("changed during preservation"),
      });
    },
  );

  it("rejects a preservation backup whose captured bytes differ from the snapshot", async () => {
    const fixture = await createFixture();
    await writeFile(fixture.target, previousWrapper, { mode: 0o755 });
    const substituted = join(fixture.root, "substituted-wrapper");
    await writeFile(substituted, previousWrapper.replace("0.9.0", "0.8.0"), {
      mode: 0o755,
    });
    await command(
      join(fixture.bin, "cp"),
      `argus_source=
argus_destination=
for argus_item do
  argus_destination=$argus_item
  case "$argus_item" in -*) ;; *) [ -n "$argus_source" ] || argus_source=$argus_item ;; esac
done
if [ "$argus_source" = "$ARGUS_INSTALL_TARGET" ] && [ "\${ARGUS_FIXTURE_SUBSTITUTE_BACKUP:-0}" = 1 ]; then
  /bin/cp "$ARGUS_FIXTURE_SUBSTITUTED_WRAPPER" "$argus_destination"
  exit 0
fi
exec /bin/cp "$@"`,
    );
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");

    await expect(
      runInstaller(fixture, Buffer.from(JSON.stringify(manifest(wrapperSha))), {
        ARGUS_FIXTURE_SUBSTITUTE_BACKUP: "1",
        ARGUS_FIXTURE_SUBSTITUTED_WRAPPER: substituted,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("changed during preservation"),
    });
  });

  it("rejects a launcher substituted after its original snapshot and before backup", async () => {
    const fixture = await createFixture();
    await writeFile(fixture.target, previousWrapper, { mode: 0o755 });
    const substituted = join(fixture.root, "snapshot-substituted-wrapper");
    await writeFile(substituted, previousWrapper.replace("0.9.0", "0.8.0"), {
      mode: 0o755,
    });
    const statCount = join(fixture.root, "target-stat-count");
    await command(
      join(fixture.bin, "stat"),
      `argus_last=
for argus_item do argus_last=$argus_item; done
if [ "$argus_last" = "$ARGUS_INSTALL_TARGET" ] && [ "\${1:-}" = -f ]; then
  argus_count=0
  [ ! -f "$ARGUS_FIXTURE_STAT_COUNT" ] || argus_count=$(cat "$ARGUS_FIXTURE_STAT_COUNT")
  argus_count=$((argus_count + 1))
  printf '%s' "$argus_count" > "$ARGUS_FIXTURE_STAT_COUNT"
  if [ "$argus_count" -eq 4 ]; then
    /bin/cp "$ARGUS_FIXTURE_SUBSTITUTED_WRAPPER" "$ARGUS_INSTALL_TARGET"
  fi
fi
exec /usr/bin/stat "$@"`,
    );
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");

    await expect(
      runInstaller(fixture, Buffer.from(JSON.stringify(manifest(wrapperSha))), {
        ARGUS_FIXTURE_STAT_COUNT: statCount,
        ARGUS_FIXTURE_SUBSTITUTED_WRAPPER: substituted,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("changed during preservation"),
    });
    expect(await readFile(fixture.target, "utf8")).toBe(
      previousWrapper.replace("0.9.0", "0.8.0"),
    );
  });

  it("does not execute a launcher swapped after promotion verification", async () => {
    const fixture = await createFixture();
    const executionMarker = join(fixture.root, "swapped-launcher-executed");
    const swappedLauncher = join(fixture.root, "swapped-launcher");
    await writeFile(
      swappedLauncher,
      `#!/bin/sh
printf '%s\\n' executed > '${executionMarker}'
printf '%s\\n' 1.2.3
`,
      { mode: 0o755 },
    );
    await command(
      join(fixture.bin, "cmp"),
      `argus_source=
argus_destination=
for argus_item do
  case "$argus_item" in -*) ;; *)
    if [ -z "$argus_source" ]; then argus_source=$argus_item; else argus_destination=$argus_item; fi
    ;;
  esac
done
/usr/bin/cmp "$@"
argus_status=$?
if [ "$argus_status" -eq 0 ] && [ "$argus_destination" = "$ARGUS_INSTALL_TARGET" ] &&
  [ "\${ARGUS_FIXTURE_SWAP_AFTER_VERIFY:-0}" = 1 ]; then
  /bin/cp "$ARGUS_FIXTURE_SWAPPED_LAUNCHER" "$ARGUS_INSTALL_TARGET"
fi
exit "$argus_status"`,
    );
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");

    await expect(
      runInstaller(fixture, Buffer.from(JSON.stringify(manifest(wrapperSha))), {
        ARGUS_FIXTURE_SWAP_AFTER_VERIFY: "1",
        ARGUS_FIXTURE_SWAPPED_LAUNCHER: swappedLauncher,
      }),
    ).resolves.toMatchObject({ stdout: "argus onboard\n" });
    await expect(lstat(executionMarker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("quarantines a promoted state instead of deleting it by its live path", async () => {
    const fixture = await createFixture();
    const removalMarker = join(fixture.root, "live-state-removal");
    const syncCount = join(fixture.root, "sync-count");
    await command(
      join(fixture.bin, "sync"),
      `argus_count=0
[ ! -f "$ARGUS_SYNC_COUNT" ] || argus_count=$(cat "$ARGUS_SYNC_COUNT")
argus_count=$((argus_count + 1))
printf '%s' "$argus_count" > "$ARGUS_SYNC_COUNT"
[ "$argus_count" -ne 5 ]`,
    );
    await command(
      join(fixture.bin, "rm"),
      `for argus_item do
  if [ "$argus_item" = "$ARGUS_STATE_PATH" ]; then
    : > "$ARGUS_FIXTURE_LIVE_REMOVAL_MARKER"
    exit 1
  fi
done
exec /bin/rm "$@"`,
    );
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");

    await expect(
      runInstaller(fixture, Buffer.from(JSON.stringify(manifest(wrapperSha))), {
        ARGUS_SYNC_COUNT: syncCount,
        ARGUS_STATE_PATH: fixture.state,
        ARGUS_FIXTURE_LIVE_REMOVAL_MARKER: removalMarker,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("previous state was restored"),
    });
    await expect(lstat(removalMarker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replaces a recognized release-specific legacy wrapper with the signed durable launcher", async () => {
    const fixture = await createFixture();
    await writeFile(fixture.target, previousWrapper, { mode: 0o755 });
    await writeFile(
      fixture.state,
      `schema=1\nversion=0.9.0\ncli_image=ghcr.io/gpsxtreme/argus-cli@sha256:${digest}\n`,
      { mode: 0o644 },
    );
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");

    await expect(
      runInstaller(fixture, Buffer.from(JSON.stringify(manifest(wrapperSha)))),
    ).resolves.toMatchObject({ stdout: "argus onboard\n" });
    expect(await readFile(fixture.target, "utf8")).toBe(
      await readFile(fixture.wrapper, "utf8"),
    );
    expect(parseManagementState(await readFile(fixture.state, "utf8"))).toMatchObject({
      version: "1.2.3",
    });
  });

  it("refuses target symlinks, unrelated targets, and held installer locks", async () => {
    const fixture = await createFixture();
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");
    const bytes = Buffer.from(JSON.stringify(manifest(wrapperSha)));
    await writeFile(join(fixture.root, "unrelated"), "mine");
    await symlink(join(fixture.root, "unrelated"), fixture.target);
    await expect(runInstaller(fixture, bytes)).rejects.toMatchObject({
      stderr: expect.stringContaining("symlink"),
    });

    const second = await createFixture();
    await writeFile(
      second.target,
      "mine\n# argus-host-wrapper schema=1\nargus_version=1.0.0\nargus_cli_image=spoof\n--env 'ARGUS_INSTALL_ROOT=/opt/argus'\n# generated-by=@argus/release\n",
    );
    await expect(runInstaller(second, bytes)).rejects.toMatchObject({
      stderr: expect.stringContaining("unrelated"),
    });

    const third = await createFixture();
    await mkdir(join(third.root, "installer.lock"));
    await expect(runInstaller(third, bytes)).rejects.toMatchObject({
      stderr: expect.stringContaining("in progress"),
    });
  }, 20_000);

  it("refuses symlinked installation roots and management-state targets", async () => {
    const fixture = await createFixture();
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");
    const bytes = Buffer.from(JSON.stringify(manifest(wrapperSha)));
    const rootTarget = join(fixture.root, "real-root");
    await rm(fixture.installRoot, { recursive: true });
    await mkdir(rootTarget);
    await symlink(rootTarget, fixture.installRoot);
    await expect(runInstaller(fixture, bytes)).rejects.toMatchObject({
      stderr: expect.stringContaining("symlinked Argus installation root"),
    });

    const stateFixture = await createFixture();
    const stateFixtureWrapperSha = createHash("sha256")
      .update(await readFile(stateFixture.wrapper))
      .digest("hex");
    const stateFixtureBytes = Buffer.from(
      JSON.stringify(manifest(stateFixtureWrapperSha)),
    );
    await writeFile(join(stateFixture.root, "state-target"), "untrusted\n");
    await symlink(join(stateFixture.root, "state-target"), stateFixture.state);
    await expect(runInstaller(stateFixture, stateFixtureBytes)).rejects.toMatchObject({
      stderr: expect.stringContaining("symlink"),
    });
  });

  it("fails deterministically for unsupported platform and missing Docker", async () => {
    const fixture = await createFixture();
    await writeFile(fixture.osRelease, "ID=fedora\nVERSION_ID=42\n");
    await expect(runInstaller(fixture, Buffer.from("{}"))).rejects.toMatchObject({
      stderr: expect.stringContaining("unsupported operating system"),
    });

    const unsupportedArch = await createFixture();
    await expect(
      runInstaller(unsupportedArch, Buffer.from("{}"), {
        ARGUS_FIXTURE_ARCH: "riscv64",
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("unsupported architecture"),
    });

    const second = await createFixture();
    await writeFile(join(second.bin, "docker"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    const wrapperSha = createHash("sha256")
      .update(await readFile(second.wrapper))
      .digest("hex");
    await expect(
      runInstaller(second, Buffer.from(JSON.stringify(manifest(wrapperSha)))),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("forbids installation"),
    });
  });

  it("rejects Debian 11 before any network or target mutation", async () => {
    const fixture = await createFixture();
    await writeFile(
      fixture.osRelease,
      "ID=debian\nVERSION_ID=11\nVERSION_CODENAME=bullseye\n",
    );
    const networkRecord = join(fixture.root, "network-called");
    await command(join(fixture.bin, "curl"), `: > "${networkRecord}"`);
    await expect(runInstaller(fixture, Buffer.from("{}"))).rejects.toMatchObject({
      stderr: expect.stringContaining("supported: 12, 13"),
    });
    await expect(lstat(networkRecord)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(fixture.target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("supports inspect mode without downloads or mutation", async () => {
    const fixture = await createFixture();
    const result = await execute("sh", [fixture.installer], {
      env: {
        ...process.env,
        PATH: `${fixture.bin}:/opt/homebrew/bin:/usr/bin:/bin`,
        ARGUS_INSTALL_OS_RELEASE: fixture.osRelease,
        ARGUS_INSTALL_TARGET: fixture.target,
        ARGUS_INSTALL_INSPECT: "1",
      },
    });
    expect(result.stdout).toContain("No files were downloaded or changed.");
    await expect(lstat(fixture.target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports bounded download failures and old OpenSSL clearly", async () => {
    const fixture = await createFixture();
    await command(join(fixture.bin, "curl"), "exit 28");
    await expect(runInstaller(fixture, Buffer.from("{}"))).rejects.toMatchObject({
      stderr: expect.stringContaining("failed to download release manifest"),
    });

    const second = await createFixture();
    await command(
      join(second.bin, "openssl"),
      'printf "%s\\n" "old pkeyutl" >&2; exit 0',
    );
    await expect(runInstaller(second, Buffer.from("{}"))).rejects.toMatchObject({
      stderr: expect.stringContaining("OpenSSL 3 or newer"),
    });
  });

  it("rejects version mismatches and os-release command injection as data", async () => {
    const fixture = await createFixture();
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");
    const bytes = Buffer.from(JSON.stringify(manifest(wrapperSha)));
    await expect(
      runInstaller(fixture, bytes, { ARGUS_VERSION: "1.2.4" }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("does not match requested"),
    });

    const marker = join(fixture.root, "must-not-exist");
    await writeFile(
      fixture.osRelease,
      `ID=ubuntu\nVERSION_ID=24.04\nVERSION_CODENAME=$(touch${marker})\n`,
    );
    await expect(runInstaller(fixture, bytes)).rejects.toMatchObject({
      stderr: expect.stringContaining("unsafe value"),
    });
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts the standard os-release symlink and rejects every other target", async () => {
    const fixture = await createFixture();
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");
    const bytes = Buffer.from(JSON.stringify(manifest(wrapperSha)));
    const etc = join(fixture.root, "etc");
    const usrLib = join(fixture.root, "usr", "lib");
    await mkdir(etc);
    await mkdir(usrLib, { recursive: true });
    await writeFile(
      join(usrLib, "os-release"),
      "ID=ubuntu\nVERSION_ID=24.04\nVERSION_CODENAME=noble\n",
    );
    fixture.osRelease = join(etc, "os-release");
    await symlink("../usr/lib/os-release", fixture.osRelease);

    await expect(runInstaller(fixture, bytes)).resolves.toBeDefined();

    const unsafe = await createFixture();
    const unsafeLink = join(unsafe.root, "linked-os-release");
    await symlink(unsafe.osRelease, unsafeLink);
    unsafe.osRelease = unsafeLink;
    await expect(runInstaller(unsafe, bytes)).rejects.toMatchObject({
      stderr: expect.stringContaining("refusing symlinked os-release"),
    });
  });

  it("fails closed without a tty when Docker approval is unspecified", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.bin, "docker"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");
    await expect(
      runInstaller(
        fixture,
        Buffer.from(JSON.stringify(manifest(wrapperSha))),
        { ARGUS_INSTALL_DOCKER: "" },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("no controlling terminal"),
    });
  });

  it("reads Docker decline only from a controlling TTY and performs no mutation", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.bin, "docker"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    const aptRecord = join(fixture.root, "apt-called");
    await command(join(fixture.bin, "apt-get"), `: > "${aptRecord}"`);
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");
    const result = await runInstallerInPty(
      fixture,
      Buffer.from(JSON.stringify(manifest(wrapperSha))),
      "n\n",
    );
    expect(result.output).toContain("official apt repository? [y/N]");
    expect(result.output).toContain("Docker installation declined");
    await expect(lstat(fixture.target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(aptRecord)).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it.each([
    ["invalid input", "maybe\n", "Docker installation declined"],
    ["TTY EOF", "", "could not read Docker installation approval"],
  ])("fails closed on %s", async (_label, answer, expected) => {
    const fixture = await createFixture();
    await writeFile(join(fixture.bin, "docker"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");
    const result = await runInstallerInPty(
      fixture,
      Buffer.from(JSON.stringify(manifest(wrapperSha))),
      answer,
    );
    expect(result.output).toContain(expected);
    await expect(lstat(fixture.target)).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it("executes the Docker install path only after yes from the controlling TTY", async () => {
    const fixture = await createFixture();
    const sentinel = join(fixture.root, "docker-installed");
    const fakeEtc = join(fixture.root, "etc");
    await mkdir(fakeEtc);
    await command(join(fixture.bin, "id"), 'printf "%s\\n" 0');
    await command(
      join(fixture.bin, "docker"),
      `[ -f "$ARGUS_FIXTURE_DOCKER_SENTINEL" ] || exit 1
case "$*" in "info"|"compose version") exit 0 ;; *) exit 64 ;; esac`,
    );
    await command(
      join(fixture.bin, "apt-get"),
      `case " $* " in *" docker-ce "*) : > "$ARGUS_FIXTURE_DOCKER_SENTINEL" ;; esac`,
    );
    await command(join(fixture.bin, "dpkg"), "exit 0");
    await command(join(fixture.bin, "dpkg-query"), "exit 1");
    await command(join(fixture.bin, "timeout"), 'shift; exec "$@"');
    await command(join(fixture.bin, "install"), "exit 0");
    await command(
      join(fixture.bin, "gpg"),
      `case " $* " in
  *" --import "*) exit 0 ;;
  *" --list-keys "*) printf '%s\\n' 'pub:::::::::' 'fpr:::::::::9DC858229FC7DD38854AE2D88D81803C0EBFCD88:' 'sub:::::::::' 'fpr:::::::::AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:' ;;
  *" --export "*) printf '%s\\n' fixture ;;
  *) exit 64 ;;
esac`,
    );
    await command(join(fixture.bin, "systemctl"), "exit 0");
    await command(
      join(fixture.bin, "install"),
      `argus_last=
argus_previous=
for argus_item do argus_previous=$argus_last; argus_last=$argus_item; done
case "$argus_last" in
  /etc/*)
    argus_mapped="$ARGUS_FIXTURE_ETC$argus_last"
    case " $* " in *" -d "*) mkdir -p "$argus_mapped" ;; *) mkdir -p "$(dirname "$argus_mapped")"; cp "$argus_previous" "$argus_mapped" ;; esac
    ;;
  *) exec /usr/bin/install "$@" ;;
esac`,
    );
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");
    const result = await runInstallerInPty(
      fixture,
      Buffer.from(JSON.stringify(manifest(wrapperSha))),
      "y\n",
      {
        ARGUS_FIXTURE_DOCKER_SENTINEL: sentinel,
        ARGUS_FIXTURE_ETC: fakeEtc,
      },
    );
    expect(result.output).toContain("official apt repository? [y/N]");
    expect(result.output).toContain("argus onboard");
    expect(await readFile(sentinel, "utf8")).toBe("");
    expect((await lstat(fixture.target)).isFile()).toBe(true);
  }, 20_000);

  it("installs Docker only with explicit automation approval from the pinned apt repository", async () => {
    const fixture = await createFixture();
    const sentinel = join(fixture.root, "docker-installed");
    const fakeEtc = join(fixture.root, "etc");
    await mkdir(fakeEtc);
    await command(join(fixture.bin, "id"), 'printf "%s\\n" 0');
    await command(
      join(fixture.bin, "docker"),
      `[ -f "$ARGUS_FIXTURE_DOCKER_SENTINEL" ] || exit 1
case "$*" in "info"|"compose version") exit 0 ;; *) exit 64 ;; esac`,
    );
    await command(
      join(fixture.bin, "apt-get"),
      `case " $* " in *" docker-ce "*) : > "$ARGUS_FIXTURE_DOCKER_SENTINEL" ;; esac
exit 0`,
    );
    await command(join(fixture.bin, "dpkg"), "exit 0");
    await command(join(fixture.bin, "dpkg-query"), "exit 1");
    await command(join(fixture.bin, "timeout"), 'shift; exec "$@"');
    await command(join(fixture.bin, "install"), "exit 0");
    await command(
      join(fixture.bin, "gpg"),
      `case " $* " in
  *" --import "*) exit 0 ;;
  *" --list-keys "*)
    printf '%s\\n' 'pub:::::::::' 'fpr:::::::::9DC858229FC7DD38854AE2D88D81803C0EBFCD88:' 'sub:::::::::' 'fpr:::::::::AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:'
    if [ "\${ARGUS_FIXTURE_EXTRA_DOCKER_PRIMARY:-0}" = 1 ]; then
      printf '%s\\n' 'pub:::::::::' 'fpr:::::::::BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB:'
    fi
    ;;
  *" --export "*) printf '%s\\n' '-----BEGIN PGP PUBLIC KEY BLOCK-----' fixture '-----END PGP PUBLIC KEY BLOCK-----' ;;
  *) exit 64 ;;
esac`,
    );
    await command(join(fixture.bin, "systemctl"), "exit 0");
    await command(
      join(fixture.bin, "install"),
      `argus_last=
argus_previous=
for argus_item do argus_previous=$argus_last; argus_last=$argus_item; done
case "$argus_last" in
  /etc/*)
    argus_mapped="$ARGUS_FIXTURE_ETC$argus_last"
    case " $* " in
      *" -d "*) mkdir -p "$argus_mapped" ;;
      *) mkdir -p "$(dirname "$argus_mapped")"; cp "$argus_previous" "$argus_mapped" ;;
    esac
    ;;
  *) exec /usr/bin/install "$@" ;;
esac`,
    );
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");
    const result = await runInstaller(
      fixture,
      Buffer.from(JSON.stringify(manifest(wrapperSha))),
      {
        ARGUS_INSTALL_DOCKER: "1",
        ARGUS_FIXTURE_DOCKER_SENTINEL: sentinel,
        ARGUS_FIXTURE_ETC: fakeEtc,
      },
    );
    expect(result.stdout).toBe("argus onboard\n");
    expect(await readFile(sentinel, "utf8")).toBe("");
    expect(
      await readFile(join(fakeEtc, "etc/apt/sources.list.d/docker.sources"), "utf8"),
    ).toContain("URIs: https://download.docker.com/linux/ubuntu");
    expect(
      await readFile(join(fakeEtc, "etc/apt/keyrings/docker.asc"), "utf8"),
    ).toContain("BEGIN PGP PUBLIC KEY BLOCK");
  }, 20_000);

  it("rejects an extra primary Docker key before repository mutation", async () => {
    const fixture = await createFixture();
    const sentinel = join(fixture.root, "docker-installed");
    await command(join(fixture.bin, "id"), 'printf "%s\\n" 0');
    await command(join(fixture.bin, "docker"), "exit 1");
    await command(join(fixture.bin, "apt-get"), "exit 0");
    await command(join(fixture.bin, "dpkg"), "exit 0");
    await command(join(fixture.bin, "dpkg-query"), "exit 1");
    await command(join(fixture.bin, "timeout"), 'shift; exec "$@"');
    await command(join(fixture.bin, "install"), "exit 0");
    await command(
      join(fixture.bin, "gpg"),
      `case " $* " in
  *" --import "*) exit 0 ;;
  *" --list-keys "*) printf '%s\\n' 'pub:::::::::' 'fpr:::::::::9DC858229FC7DD38854AE2D88D81803C0EBFCD88:' 'sub:::::::::' 'fpr:::::::::AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:' 'pub:::::::::' 'fpr:::::::::BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB:' ;;
  *) exit 64 ;;
esac`,
    );
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");
    await expect(
      runInstaller(
        fixture,
        Buffer.from(JSON.stringify(manifest(wrapperSha))),
        {
          ARGUS_INSTALL_DOCKER: "1",
          ARGUS_FIXTURE_DOCKER_SENTINEL: sentinel,
          ARGUS_FIXTURE_ETC: join(fixture.root, "etc"),
        },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("exactly one primary key"),
    });
  }, 20_000);

  it("rejects a wrong Docker primary-key fingerprint", async () => {
    const fixture = await createFixture();
    await command(join(fixture.bin, "id"), 'printf "%s\\n" 0');
    await command(join(fixture.bin, "docker"), "exit 1");
    await command(join(fixture.bin, "apt-get"), "exit 0");
    await command(join(fixture.bin, "dpkg"), "exit 0");
    await command(join(fixture.bin, "dpkg-query"), "exit 1");
    await command(join(fixture.bin, "timeout"), 'shift; exec "$@"');
    await command(join(fixture.bin, "install"), "exit 0");
    await command(
      join(fixture.bin, "gpg"),
      `case " $* " in
  *" --import "*) exit 0 ;;
  *" --list-keys "*) printf '%s\\n' 'pub:::::::::' 'fpr:::::::::BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB:' ;;
  *) exit 64 ;;
esac`,
    );
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");
    await expect(
      runInstaller(
        fixture,
        Buffer.from(JSON.stringify(manifest(wrapperSha))),
        { ARGUS_INSTALL_DOCKER: "1" },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("fingerprint did not match"),
    });
  }, 20_000);

  it("fails closed on conflicting distro Docker packages before apt mutation", async () => {
    const fixture = await createFixture();
    const aptRecord = join(fixture.root, "apt-called");
    await command(
      join(fixture.bin, "docker"),
      'case "$*" in info) exit 0 ;; "compose version") exit 1 ;; *) exit 64 ;; esac',
    );
    await command(join(fixture.bin, "dpkg"), "exit 0");
    await command(
      join(fixture.bin, "dpkg-query"),
      `argus_last=
for argus_item do argus_last=$argus_item; done
case "$argus_last" in docker.io|containerd) printf '%s' 'install ok installed'; exit 0 ;; esac
exit 1`,
    );
    await command(join(fixture.bin, "timeout"), 'shift; exec "$@"');
    await command(join(fixture.bin, "apt-get"), `: > "${aptRecord}"`);
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");
    await expect(
      runInstaller(
        fixture,
        Buffer.from(JSON.stringify(manifest(wrapperSha))),
        { ARGUS_INSTALL_DOCKER: "1" },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("conflicting distro Docker packages"),
    });
    await expect(lstat(aptRecord)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
