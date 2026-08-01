import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { execFile } from "node:child_process";
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
import { renderInstaller } from "../src/installer.js";

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

const manifest = (wrapperSha: string, wrapperUrl = "https://fixture.invalid/wrapper") => ({
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
set -eu
argus_cli_image='ghcr.io/gpsxtreme/argus-cli@sha256:${digest}'
# ARGUS_INSTALL_ROOT=/opt/argus
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
      ARGUS_INSTALL_OS_RELEASE: fixture.osRelease,
      ARGUS_INSTALL_TARGET: fixture.target,
      ARGUS_INSTALL_LOCK: join(fixture.root, "installer.lock"),
      ARGUS_INSTALL_DOCKER: "0",
      ARGUS_FIXTURE_WRAPPER: fixture.wrapper,
      ...environment,
    },
  });
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
    expect(installer).not.toContain("eval ");
    expect(installer).not.toContain(". /etc/os-release");
    expect(installer).toContain("argus onboard");
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
  });

  it("rejects a bad signature before trusting manifest fields", async () => {
    const fixture = await createFixture();
    const bytes = Buffer.from(JSON.stringify(manifest(digest)));
    await expect(
      runInstaller(fixture, bytes, {}, Buffer.alloc(64)),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("signature is invalid"),
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
      "#!/bin/sh\nargus_cli_image=old\n# ARGUS_INSTALL_ROOT=/opt/argus\nprintf '%s\\n' 0.9.0\n",
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
    await writeFile(second.target, "mine");
    await expect(runInstaller(second, bytes)).rejects.toMatchObject({
      stderr: expect.stringContaining("unrelated"),
    });

    const third = await createFixture();
    await mkdir(join(third.root, "installer.lock"));
    await expect(runInstaller(third, bytes)).rejects.toMatchObject({
      stderr: expect.stringContaining("in progress"),
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
      stderr: expect.stringContaining("OpenSSL is too old"),
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
    await command(join(fixture.bin, "timeout"), 'shift; exec "$@"');
    await command(
      join(fixture.bin, "gpg"),
      `printf '%s\\n' 'fpr:::::::::9DC858229FC7DD38854AE2D88D81803C0EBFCD88:'`,
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
  });
});
