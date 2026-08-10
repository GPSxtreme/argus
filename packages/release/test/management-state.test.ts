import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MANAGEMENT_WRAPPER_REQUIREMENTS,
} from "@argus/contracts";
import {
  managementStateForRelease,
  parseManagementState,
  serializeManagementState,
  writeManagementStateAtomic,
  type ManagementStateFileSystem,
  type ManagementStateV1,
} from "../src/management-state.js";
import type { VerifiedReleaseManifest } from "../src/manifest.js";

const digest = "a".repeat(64);
const state: ManagementStateV1 = {
  schema: 1,
  version: "0.1.13",
  cliImage: `ghcr.io/gpsxtreme/argus-cli@sha256:${digest}`,
};
const valid = `schema=1\nversion=0.1.13\ncli_image=ghcr.io/gpsxtreme/argus-cli@sha256:${digest}\n`;
const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "argus-management-state-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("management state parsing and serialization", () => {
  it("parses the exact three-line V1 state", () => {
    expect(parseManagementState(valid)).toEqual(state);
  });

  it("serializes one deterministic byte representation", () => {
    expect(serializeManagementState(state)).toBe(valid);
    expect(serializeManagementState({ ...state })).toBe(valid);
  });

  it("derives state only from a verified release's selected CLI image", () => {
    const release = {
      manifest: {
        version: "2.3.4-rc.1",
        images: {
          cli: {
            reference: `ghcr.io/gpsxtreme/argus-cli@sha256:${"b".repeat(64)}`,
          },
        },
      },
    } as VerifiedReleaseManifest;

    expect(managementStateForRelease(release)).toEqual({
      schema: 1,
      version: "2.3.4-rc.1",
      cliImage: `ghcr.io/gpsxtreme/argus-cli@sha256:${"b".repeat(64)}`,
    });
  });

  it.each([
    ["missing terminal newline", valid.slice(0, -1)],
    ["extra key", `${valid}extra=x\n`],
    ["reordered keys", `version=0.1.13\nschema=1\ncli_image=ghcr.io/gpsxtreme/argus-cli@sha256:${digest}\n`],
    ["duplicate key", `schema=1\nversion=0.1.13\nversion=0.1.13\ncli_image=ghcr.io/gpsxtreme/argus-cli@sha256:${digest}\n`],
    ["missing key", `schema=1\nversion=0.1.13\n`],
    ["CRLF", valid.replaceAll("\n", "\r\n")],
    ["blank line", `schema=1\n\nversion=0.1.13\ncli_image=ghcr.io/gpsxtreme/argus-cli@sha256:${digest}\n`],
    ["leading whitespace", ` schema=1\nversion=0.1.13\ncli_image=ghcr.io/gpsxtreme/argus-cli@sha256:${digest}\n`],
    ["trailing whitespace", `schema=1\nversion=0.1.13 \ncli_image=ghcr.io/gpsxtreme/argus-cli@sha256:${digest}\n`],
    ["unnormalized SemVer", `schema=1\nversion=01.1.13\ncli_image=ghcr.io/gpsxtreme/argus-cli@sha256:${digest}\n`],
    ["uppercase digest", `schema=1\nversion=0.1.13\ncli_image=ghcr.io/gpsxtreme/argus-cli@sha256:${"A".repeat(64)}\n`],
    ["credentials", `schema=1\nversion=0.1.13\ncli_image=user:secret@ghcr.io/gpsxtreme/argus-cli@sha256:${digest}\n`],
    ["tag without digest", "schema=1\nversion=0.1.13\ncli_image=ghcr.io/gpsxtreme/argus-cli:0.1.13\n"],
    ["NUL byte", valid.replace("version", "ver\u0000sion")],
    ["wrong schema", `schema=2\nversion=0.1.13\ncli_image=ghcr.io/gpsxtreme/argus-cli@sha256:${digest}\n`],
    ["oversize input", `${valid}${"x".repeat(MANAGEMENT_WRAPPER_REQUIREMENTS.maximumStateBytes)}`],
  ])("rejects %s", (_name, source) => {
    expect(() => parseManagementState(source)).toThrow("management state");
  });

  it.each([
    { ...state, schema: 2 },
    { ...state, version: "v0.1.13" },
    { ...state, cliImage: "ghcr.io/gpsxtreme/argus-cli:0.1.13" },
  ])("refuses noncanonical values during serialization", (invalid) => {
    expect(() => serializeManagementState(invalid as ManagementStateV1)).toThrow(
      "management state",
    );
  });

  it("refuses a valid state that exceeds the byte limit before serializing or writing", async () => {
    const oversizedState: ManagementStateV1 = {
      ...state,
      version: `0.1.13+${"a".repeat(MANAGEMENT_WRAPPER_REQUIREMENTS.maximumStateBytes)}`,
    };
    const directory = await temporaryDirectory();
    const path = join(directory, "management.state");

    expect(() => serializeManagementState(oversizedState)).toThrow("management state");
    await expect(writeManagementStateAtomic(path, oversizedState)).rejects.toThrow(
      "management state",
    );
  });
});

describe("writeManagementStateAtomic", () => {
  it("writes the canonical state with mode 0644", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "management.state");

    await writeManagementStateAtomic(path, state);

    expect(await readFile(path, "utf8")).toBe(valid);
    expect((await lstat(path)).mode & 0o777).toBe(0o644);
  });

  it("uses a same-directory durable rename sequence", async () => {
    const events: string[] = [];
    const filesystem = recordingFileSystem(events);

    await writeManagementStateAtomic("/opt/argus/management.state", state, filesystem);

    expect(events).toEqual([
      "lstat:/opt/argus/management.state",
      expect.stringMatching(/^open:\/opt\/argus\/\.management\.state\.[^.]+\.tmp:wx:644$/u),
      `write:${valid}`,
      "chmod:644",
      "sync:file",
      "close:file",
      "lstat:/opt/argus/management.state",
      expect.stringMatching(
        /^rename:\/opt\/argus\/management\.state:\/opt\/argus\/\.management\.state\.backup-[^.]+$/u,
      ),
      "open:/opt/argus:r",
      "sync:directory",
      "close:directory",
      expect.stringMatching(/^lstat:\/opt\/argus\/\.management\.state\.[^.]+\.tmp$/u),
      "lstat:/opt/argus/management.state",
      expect.stringMatching(
        /^rename:\/opt\/argus\/\.management\.state\.[^.]+\.tmp:\/opt\/argus\/management\.state$/u,
      ),
      "open:/opt/argus:r",
      "sync:directory",
      "close:directory",
      expect.stringMatching(/^unlink:\/opt\/argus\/\.management\.state\.backup-[^.]+$/u),
      "open:/opt/argus:r",
      "sync:directory",
      "close:directory",
    ]);
  });

  it("cleans up a pre-rename failure and preserves the previous state", async () => {
    const events: string[] = [];
    const filesystem = recordingFileSystem(events, { failFileSync: true });

    await expect(
      writeManagementStateAtomic("/opt/argus/management.state", state, filesystem),
    ).rejects.toThrow("injected file sync failure");

    expect(events.some((event) => event.startsWith("unlink:/opt/argus/.management.state."))).toBe(
      true,
    );
    expect(events.some((event) => event.startsWith("rename:"))).toBe(false);
    expect(filesystem.targetContents).toBe("previous state\n");
  });

  it("restores the prior state when the parent sync fails after promotion rename", async () => {
    const events: string[] = [];
    const filesystem = recordingFileSystem(events, {
      failDirectorySyncWithTargetContents: valid,
    });

    await expect(
      writeManagementStateAtomic("/opt/argus/management.state", state, filesystem),
    ).rejects.toThrow("injected parent sync failure");

    expect(filesystem.targetContents).toBe("previous state\n");
  });

  it("restores prior absence when the parent sync fails after the first promotion", async () => {
    const events: string[] = [];
    const filesystem = recordingFileSystem(events, {
      targetContents: undefined,
      failDirectorySyncWithTargetContents: valid,
    });

    await expect(
      writeManagementStateAtomic("/opt/argus/management.state", state, filesystem),
    ).rejects.toThrow("injected parent sync failure");

    expect(filesystem.targetContents).toBeUndefined();
  });

  it("retains the prior state at an actionable recovery path when restoration sync fails", async () => {
    const events: string[] = [];
    const filesystem = recordingFileSystem(events, {
      failDirectorySyncWithTargetContents: [valid, "previous state\n"],
    });

    await expect(
      writeManagementStateAtomic("/opt/argus/management.state", state, filesystem),
    ).rejects.toThrow("Prior management state is retained for recovery at");

    expect(filesystem.targetContents).toBeUndefined();
    expect(filesystem.backupContents).toBe("previous state\n");
  });

  it("retains the prior state at an actionable recovery path when restoration rename fails", async () => {
    const events: string[] = [];
    const filesystem = recordingFileSystem(events, {
      failDirectorySyncWithTargetContents: valid,
      failRestoreRename: true,
    });

    await expect(
      writeManagementStateAtomic("/opt/argus/management.state", state, filesystem),
    ).rejects.toThrow("Prior management state is retained for recovery at");

    expect(filesystem.backupContents).toBe("previous state\n");
  });

  it("fails visibly when cleanup cannot remove the prior-state recovery material", async () => {
    const events: string[] = [];
    const filesystem = recordingFileSystem(events, { failBackupUnlink: true });

    await expect(
      writeManagementStateAtomic("/opt/argus/management.state", state, filesystem),
    ).rejects.toThrow("Management state was durably promoted");

    expect(filesystem.targetContents).toBe(valid);
    expect(filesystem.backupContents).toBe("previous state\n");
  });

  it("rejects a symlink target before opening a temporary replacement", async () => {
    const events: string[] = [];
    const filesystem = recordingFileSystem(events, { targetIsSymlink: true });

    await expect(
      writeManagementStateAtomic("/opt/argus/management.state", state, filesystem),
    ).rejects.toThrow("symlink");

    expect(events).toEqual(["lstat:/opt/argus/management.state"]);
  });

  it("rejects a target that becomes a symlink before rename", async () => {
    const events: string[] = [];
    const filesystem = recordingFileSystem(events, { targetBecomesSymlink: true });

    await expect(
      writeManagementStateAtomic("/opt/argus/management.state", state, filesystem),
    ).rejects.toThrow("symlink");

    expect(events.filter((event) => event === "lstat:/opt/argus/management.state")).toHaveLength(
      2,
    );
    expect(events.some((event) => event.startsWith("rename:"))).toBe(false);
    expect(events.some((event) => event.startsWith("unlink:"))).toBe(true);
  });

  it("rejects a real symlink without replacing its referent", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "target.state");
    const path = join(directory, "management.state");
    await writeFile(target, "previous state\n");
    await symlink(target, path);

    await expect(writeManagementStateAtomic(path, state)).rejects.toThrow("symlink");

    expect(await readFile(target, "utf8")).toBe("previous state\n");
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
  });
});

const recordingFileSystem = (
  events: string[],
  options: {
    failFileSync?: boolean;
    failDirectorySyncWithTargetContents?: string | string[];
    failBackupUnlink?: boolean;
    failRestoreRename?: boolean;
    targetContents?: string | undefined;
    targetIsSymlink?: boolean;
    targetBecomesSymlink?: boolean;
  } = {},
): ManagementStateFileSystem & {
  targetContents: string | undefined;
  backupContents: string | undefined;
} => {
  const target = "/opt/argus/management.state";
  let targetLstatCount = 0;
  const contentsByPath = new Map<string, string>();
  if (options.targetContents !== undefined || !("targetContents" in options)) {
    contentsByPath.set(target, options.targetContents ?? "previous state\n");
  }
  const directorySyncFailures =
    options.failDirectorySyncWithTargetContents === undefined
      ? []
      : Array.isArray(options.failDirectorySyncWithTargetContents)
        ? [...options.failDirectorySyncWithTargetContents]
        : [options.failDirectorySyncWithTargetContents];
  const missing = (path: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}'`), {
      code: "ENOENT",
    });
  const file = {
    writeFile: async (written: string): Promise<void> => {
      events.push(`write:${written}`);
      const temporary = [...contentsByPath.keys()].find((path) =>
        path.includes(".management.state."),
      );
      if (temporary === undefined) throw new Error("temporary management state is missing");
      contentsByPath.set(temporary, written);
    },
    chmod: async (mode: number): Promise<void> => {
      events.push(`chmod:${mode.toString(8)}`);
    },
    sync: async (): Promise<void> => {
      events.push("sync:file");
      if (options.failFileSync) throw new Error("injected file sync failure");
    },
    close: async (): Promise<void> => {
      events.push("close:file");
    },
  };
  const directory = {
    writeFile: async (): Promise<void> => {
      throw new Error("directory cannot be written");
    },
    chmod: async (): Promise<void> => {
      throw new Error("directory cannot be chmodded");
    },
    sync: async (): Promise<void> => {
      events.push("sync:directory");
      if (
        directorySyncFailures.length > 0 &&
        directorySyncFailures[0] === contentsByPath.get(target)
      ) {
        directorySyncFailures.shift();
        throw new Error("injected parent sync failure");
      }
    },
    close: async (): Promise<void> => {
      events.push("close:directory");
    },
  };

  return {
    get targetContents(): string | undefined {
      return contentsByPath.get(target);
    },
    get backupContents(): string | undefined {
      return [...contentsByPath.entries()].find(([path]) =>
        path.includes(".management.state.backup-"),
      )?.[1];
    },
    lstat: async (path: string) => {
      events.push(`lstat:${path}`);
      if (path === target) targetLstatCount += 1;
      if (path === target && options.targetIsSymlink) {
        return { isSymbolicLink: () => true };
      }
      if (path === target && options.targetBecomesSymlink && targetLstatCount === 2) {
        return { isSymbolicLink: () => true };
      }
      if (!contentsByPath.has(path)) throw missing(path);
      return { isSymbolicLink: () => false };
    },
    open: async (path: string, flags: string, mode?: number) => {
      events.push(`open:${path}:${flags}${mode === undefined ? "" : `:${mode.toString(8)}`}`);
      if (path !== "/opt/argus" && flags === "wx") contentsByPath.set(path, "");
      return path === "/opt/argus" ? directory : file;
    },
    rename: async (from: string, to: string): Promise<void> => {
      events.push(`rename:${from}:${to}`);
      if (options.failRestoreRename && from.includes(".management.state.backup-")) {
        throw new Error("injected restore rename failure");
      }
      const source = contentsByPath.get(from);
      if (source === undefined) throw missing(from);
      contentsByPath.delete(from);
      contentsByPath.set(to, source);
    },
    unlink: async (path: string): Promise<void> => {
      events.push(`unlink:${path}`);
      if (options.failBackupUnlink && path.includes(".management.state.backup-")) {
        throw new Error("injected backup cleanup failure");
      }
      contentsByPath.delete(path);
    },
  };
};
