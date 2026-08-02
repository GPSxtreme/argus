import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ReleaseManifestError,
  renderInstaller,
  serializeReleaseManifestCanonical,
  type ReleaseManifestV1,
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
  const osRelease = join(root, "os-release");
  await mkdir(bin);
  await mkdir(join(root, "install"));
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

argus_version='1.2.3'
argus_cli_image='ghcr.io/gpsxtreme/argus-cli@sha256:${digest}'
# --env 'ARGUS_INSTALL_ROOT=/opt/argus'
if [ "\${1:-}" = --version ]; then
  printf '%s\\n' "\${ARGUS_FIXTURE_WRAPPER_VERSION:-1.2.3}"
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
  await command(join(bin, "sudo"), "exit 1");
  await command(
    join(bin, "docker"),
    'case "$*" in "info"|"compose version") exit 0 ;; *) exit 64 ;; esac',
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
      ARGUS_INSTALL_LOCK: join(fixture.root, "installer.lock"),
      ARGUS_INSTALL_DOCKER: "0",
      ARGUS_FIXTURE_WRAPPER: fixture.wrapper,
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

  it("verifies a local signed fixture, installs atomically, and reinstalls idempotently", async () => {
    const fixture = await createFixture();
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");
    const bytes = Buffer.from(JSON.stringify(manifest(wrapperSha)));

    const first = await runInstaller(fixture, bytes);
    expect(first.stdout).toBe("argus onboard\n");
    expect((await lstat(fixture.target)).mode & 0o777).toBe(0o755);
    const installed = await readFile(fixture.target);
    const second = await runInstaller(fixture, bytes);
    expect(second.stdout).toBe("argus onboard\n");
    expect(await readFile(fixture.target)).toEqual(installed);
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
    const original = await readFile(fixture.target);
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
  });

  it("restores the previous wrapper when post-rename durability sync fails", async () => {
    const fixture = await createFixture();
    await writeFile(fixture.target, previousWrapper, { mode: 0o755 });
    const syncCount = join(fixture.root, "sync-count");
    await command(
      join(fixture.bin, "sync"),
      `argus_count=0
[ ! -f "$ARGUS_SYNC_COUNT" ] || argus_count=$(cat "$ARGUS_SYNC_COUNT")
argus_count=$((argus_count + 1))
printf '%s' "$argus_count" > "$ARGUS_SYNC_COUNT"
[ "$argus_count" -ne 3 ]`,
    );
    const wrapperSha = createHash("sha256")
      .update(await readFile(fixture.wrapper))
      .digest("hex");
    await expect(
      runInstaller(
        fixture,
        Buffer.from(JSON.stringify(manifest(wrapperSha))),
        { ARGUS_SYNC_COUNT: syncCount },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("previous state was restored"),
    });
    expect(await readFile(fixture.target, "utf8")).toBe(previousWrapper);
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
