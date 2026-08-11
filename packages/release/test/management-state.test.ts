import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
const concurrentState: ManagementStateV1 = {
  schema: 1,
  version: "0.1.14",
  cliImage: `ghcr.io/gpsxtreme/argus-cli@sha256:${"b".repeat(64)}`,
};
const concurrentValid = `schema=1\nversion=0.1.14\ncli_image=ghcr.io/gpsxtreme/argus-cli@sha256:${"b".repeat(64)}\n`;
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
    expect(await readdir(directory)).toEqual(["management.state"]);
  });

  it("uses a same-directory durable rename sequence", async () => {
    const events: string[] = [];
    const filesystem = recordingFileSystem(events);

    await writeManagementStateAtomic("/opt/argus/management.state", state, filesystem);

    expect(events).toEqual([
      "open:/opt/argus/.management.state.lock:wx:600",
      "stat:/opt/argus/.management.state.lock",
      "chmod:600",
      "sync:file",
      "lstat:/opt/argus/.management.state.lock",
      "open:/opt/argus:r",
      "sync:directory",
      "close:directory",
      "lstat:/opt/argus/.management.state.lock",
      "lstat:/opt/argus/management.state",
      expect.stringMatching(/^open:\/opt\/argus\/\.management\.state\.[^.]+\.tmp:wx:644$/u),
      `write:${valid}`,
      "chmod:644",
      "sync:file",
      expect.stringMatching(/^stat:\/opt\/argus\/\.management\.state\.[^.]+\.tmp$/u),
      "close:file",
      "lstat:/opt/argus/management.state",
      expect.stringMatching(
        /^rename:\/opt\/argus\/management\.state:\/opt\/argus\/\.management\.state\.backup-[^.]+$/u,
      ),
      expect.stringMatching(/^lstat:\/opt\/argus\/\.management\.state\.backup-[^.]+$/u),
      "open:/opt/argus:r",
      "sync:directory",
      "close:directory",
      expect.stringMatching(/^lstat:\/opt\/argus\/\.management\.state\.backup-[^.]+$/u),
      "lstat:/opt/argus/management.state",
      expect.stringMatching(/^lstat:\/opt\/argus\/\.management\.state\.[^.]+\.tmp$/u),
      "lstat:/opt/argus/management.state",
      expect.stringMatching(
        /^rename:\/opt\/argus\/\.management\.state\.[^.]+\.tmp:\/opt\/argus\/management\.state$/u,
      ),
      "lstat:/opt/argus/management.state",
      "open:/opt/argus:r",
      "sync:directory",
      "close:directory",
      "lstat:/opt/argus/management.state",
      "lstat:/opt/argus/management.state",
      expect.stringMatching(/^lstat:\/opt\/argus\/\.management\.state\.backup-[^.]+$/u),
      expect.stringMatching(/^unlink:\/opt\/argus\/\.management\.state\.backup-[^.]+$/u),
      "open:/opt/argus:r",
      "sync:directory",
      "close:directory",
      "lstat:/opt/argus/management.state",
      expect.stringMatching(/^lstat:\/opt\/argus\/\.management\.state\.backup-[^.]+$/u),
      "lstat:/opt/argus/.management.state.lock",
      "unlink:/opt/argus/.management.state.lock",
      "open:/opt/argus:r",
      "sync:directory",
      "close:directory",
      "close:file",
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

  it("restores prior absence when a symlink replaces the candidate during parent sync", async () => {
    const events: string[] = [];
    const filesystem = recordingFileSystem(events, {
      targetContents: undefined,
      replaceTargetOnCandidateSync: 1,
      replacementIsSymlink: true,
    });

    await expect(
      writeManagementStateAtomic("/opt/argus/management.state", state, filesystem),
    ).rejects.toThrow("ownership");

    expect(filesystem.targetContents).toBeUndefined();
    expect(filesystem.failedCandidateIsSymlink).toBe(true);
  });

  it("restores the prior state when a foreign file replaces the candidate during parent sync", async () => {
    const events: string[] = [];
    const filesystem = recordingFileSystem(events, { replaceTargetOnCandidateSync: 1 });

    await expect(
      writeManagementStateAtomic("/opt/argus/management.state", state, filesystem),
    ).rejects.toThrow("ownership");

    expect(filesystem.targetContents).toBe("previous state\n");
    expect(filesystem.failedCandidateContents).toBe("foreign state\n");
  });

  it("detects a foreign live state after the final backup-removal sync", async () => {
    const events: string[] = [];
    const filesystem = recordingFileSystem(events, { replaceTargetOnCandidateSync: 2 });

    await expect(
      writeManagementStateAtomic("/opt/argus/management.state", state, filesystem),
    ).rejects.toThrow("ownership");

    expect(filesystem.targetContents).toBe("foreign state\n");
    expect(filesystem.backupContents).toBeUndefined();
  });

  it("retains an unknown temporary entry when candidate stat fails", async () => {
    const events: string[] = [];
    const filesystem = recordingFileSystem(events, { failCandidateStat: true });

    await expect(
      writeManagementStateAtomic("/opt/argus/management.state", state, filesystem),
    ).rejects.toThrow("ownership is unknown");

    expect(filesystem.targetContents).toBe("previous state\n");
    expect(filesystem.temporaryContents).toBe(valid);
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

  it("excludes a concurrent writer until the active transaction has recovered", async () => {
    const fixture = concurrentWriterFileSystem();
    const firstWrite = writeManagementStateAtomic(
      "/opt/argus/management.state",
      state,
      fixture.fileSystem,
    );
    await fixture.firstPromotionReady;

    const concurrentResult = await writeManagementStateAtomic(
      "/opt/argus/management.state",
      concurrentState,
      fixture.fileSystem,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    fixture.failFirstPromotion();
    await expect(firstWrite).rejects.toThrow("injected first-writer parent sync failure");

    expect(concurrentResult).toBeInstanceOf(Error);
    expect((concurrentResult as Error).message).toContain("locked");
    expect(fixture.targetContents).toBe("previous state\n");
    expect(fixture.targetContents).not.toBe(concurrentValid);
  });

  it("leaves a stale lock untouched with actionable crash-recovery guidance", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "management.state");
    const lockPath = join(directory, ".management.state.lock");
    await writeFile(path, "previous state\n", { mode: 0o600 });
    await writeFile(lockPath, "", { mode: 0o600 });

    await expect(writeManagementStateAtomic(path, state)).rejects.toThrow(
      "If no writer is active, remove the stale lock",
    );

    expect(await readFile(path, "utf8")).toBe("previous state\n");
    expect((await lstat(lockPath)).isFile()).toBe(true);
  });

  it("never installs a backup that becomes a symlink during restoration", async () => {
    const events: string[] = [];
    const filesystem = recordingFileSystem(events, {
      failDirectorySyncWithTargetContents: valid,
      swapBackupToSymlinkDuringRestore: true,
    });

    await expect(
      writeManagementStateAtomic("/opt/argus/management.state", state, filesystem),
    ).rejects.toThrow("ownership");

    expect(filesystem.targetIsSymlink).toBe(false);
    expect(filesystem.backupIsSymlink).toBe(true);
  });

  it("does not claim an ambiguously missing cleanup backup is retained", async () => {
    const events: string[] = [];
    const filesystem = recordingFileSystem(events, { backupUnlinkIsAmbiguouslyMissing: true });

    const failure = await writeManagementStateAtomic(
      "/opt/argus/management.state",
      state,
      filesystem,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("prior state remains at");
    expect((failure as Error).message).toContain("could not be confirmed");
    expect(filesystem.backupContents).toBeUndefined();
  });

  it("does not remove a lock path that no longer belongs to this writer", async () => {
    const events: string[] = [];
    const filesystem = recordingFileSystem(events, { replaceLockBeforeRelease: true });

    await expect(
      writeManagementStateAtomic("/opt/argus/management.state", state, filesystem),
    ).rejects.toThrow("lock cleanup");

    expect(filesystem.targetContents).toBe(valid);
    expect(events).not.toContain("unlink:/opt/argus/.management.state.lock");
  });

  it("rejects a symlink target before opening a temporary replacement", async () => {
    const events: string[] = [];
    const filesystem = recordingFileSystem(events, { targetIsSymlink: true });

    await expect(
      writeManagementStateAtomic("/opt/argus/management.state", state, filesystem),
    ).rejects.toThrow("symlink");

    expect(events).toContain("lstat:/opt/argus/management.state");
    expect(events.some((event) => event.includes(".tmp:wx"))).toBe(false);
    expect(events).toContain("unlink:/opt/argus/.management.state.lock");
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
    failCandidateStat?: boolean;
    failDirectorySyncWithTargetContents?: string | string[];
    failBackupUnlink?: boolean;
    failRestoreRename?: boolean;
    backupUnlinkIsAmbiguouslyMissing?: boolean;
    replaceLockBeforeRelease?: boolean;
    replaceTargetOnCandidateSync?: number;
    replacementIsSymlink?: boolean;
    swapBackupToSymlinkDuringRestore?: boolean;
    targetContents?: string | undefined;
    targetIsSymlink?: boolean;
    targetBecomesSymlink?: boolean;
  } = {},
): ManagementStateFileSystem & {
  targetContents: string | undefined;
  targetIsSymlink: boolean;
  backupContents: string | undefined;
  backupIsSymlink: boolean;
  failedCandidateContents: string | undefined;
  failedCandidateIsSymlink: boolean;
  temporaryContents: string | undefined;
} => {
  const target = "/opt/argus/management.state";
  let targetLstatCount = 0;
  let lockLstatCount = 0;
  let candidateDirectorySyncCount = 0;
  const contentsByPath = new Map<string, string>();
  const identitiesByPath = new Map<string, number>();
  let nextIdentity = 2;
  const symlinks = new Set<string>();
  if (options.targetContents !== undefined || !("targetContents" in options)) {
    contentsByPath.set(target, options.targetContents ?? "previous state\n");
    identitiesByPath.set(target, 1);
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
  const file = (path: string) => ({
    writeFile: async (written: string): Promise<void> => {
      events.push(`write:${written}`);
      contentsByPath.set(path, written);
    },
    chmod: async (mode: number): Promise<void> => {
      events.push(`chmod:${mode.toString(8)}`);
    },
    sync: async (): Promise<void> => {
      events.push("sync:file");
      if (options.failFileSync && path.endsWith(".tmp")) {
        throw new Error("injected file sync failure");
      }
    },
    stat: async () => {
      events.push(`stat:${path}`);
      if (options.failCandidateStat && path.endsWith(".tmp")) {
        throw new Error("injected candidate stat failure");
      }
      const ino = identitiesByPath.get(path);
      if (ino === undefined) throw missing(path);
      return { dev: 1, ino };
    },
    close: async (): Promise<void> => {
      events.push("close:file");
    },
  });
  const directory = {
    writeFile: async (): Promise<void> => {
      throw new Error("directory cannot be written");
    },
    chmod: async (): Promise<void> => {
      throw new Error("directory cannot be chmodded");
    },
    sync: async (): Promise<void> => {
      events.push("sync:directory");
      if (contentsByPath.get(target) === valid) {
        candidateDirectorySyncCount += 1;
        if (options.replaceTargetOnCandidateSync === candidateDirectorySyncCount) {
          contentsByPath.set(target, "foreign state\n");
          identitiesByPath.set(target, nextIdentity);
          nextIdentity += 1;
          if (options.replacementIsSymlink) symlinks.add(target);
        }
      }
      if (
        directorySyncFailures.length > 0 &&
        directorySyncFailures[0] === contentsByPath.get(target)
      ) {
        directorySyncFailures.shift();
        throw new Error("injected parent sync failure");
      }
    },
    stat: async () => ({ dev: 1, ino: 0 }),
    close: async (): Promise<void> => {
      events.push("close:directory");
    },
  };

  return {
    get targetContents(): string | undefined {
      return contentsByPath.get(target);
    },
    get targetIsSymlink(): boolean {
      return symlinks.has(target);
    },
    get backupContents(): string | undefined {
      return [...contentsByPath.entries()].find(([path]) =>
        path.includes(".management.state.backup-"),
      )?.[1];
    },
    get backupIsSymlink(): boolean {
      return [...symlinks].some((path) => path.includes(".management.state.backup-"));
    },
    get failedCandidateContents(): string | undefined {
      return [...contentsByPath.entries()].find(([path]) =>
        path.includes(".management.state.failed-"),
      )?.[1];
    },
    get failedCandidateIsSymlink(): boolean {
      return [...symlinks].some((path) => path.includes(".management.state.failed-"));
    },
    get temporaryContents(): string | undefined {
      return [...contentsByPath.entries()].find(([path]) => path.endsWith(".tmp"))?.[1];
    },
    lstat: async (path: string) => {
      events.push(`lstat:${path}`);
      if (path === target) targetLstatCount += 1;
      if (path === "/opt/argus/.management.state.lock") {
        lockLstatCount += 1;
        if (options.replaceLockBeforeRelease && lockLstatCount === 3) {
          identitiesByPath.set(path, nextIdentity);
          nextIdentity += 1;
        }
      }
      if (path === target && options.targetIsSymlink) {
        return { dev: 1, ino: identitiesByPath.get(path) ?? 1, isSymbolicLink: () => true };
      }
      if (path === target && options.targetBecomesSymlink && targetLstatCount === 2) {
        return { dev: 1, ino: identitiesByPath.get(path) ?? 1, isSymbolicLink: () => true };
      }
      if (!contentsByPath.has(path)) throw missing(path);
      const ino = identitiesByPath.get(path);
      if (ino === undefined) throw missing(path);
      return { dev: 1, ino, isSymbolicLink: () => symlinks.has(path) };
    },
    open: async (path: string, flags: string, mode?: number) => {
      events.push(`open:${path}:${flags}${mode === undefined ? "" : `:${mode.toString(8)}`}`);
      if (path !== "/opt/argus" && flags === "wx") {
        if (contentsByPath.has(path)) throw Object.assign(new Error("already exists"), { code: "EEXIST" });
        contentsByPath.set(path, "");
        identitiesByPath.set(path, nextIdentity);
        nextIdentity += 1;
      }
      return path === "/opt/argus" ? directory : file(path);
    },
    rename: async (from: string, to: string): Promise<void> => {
      events.push(`rename:${from}:${to}`);
      if (options.failRestoreRename && from.includes(".management.state.backup-")) {
        throw new Error("injected restore rename failure");
      }
      if (options.swapBackupToSymlinkDuringRestore && from.includes(".management.state.backup-")) {
        contentsByPath.set(from, "symlink target");
        identitiesByPath.set(from, nextIdentity);
        nextIdentity += 1;
        symlinks.add(from);
      }
      const source = contentsByPath.get(from);
      if (source === undefined) throw missing(from);
      contentsByPath.delete(from);
      contentsByPath.set(to, source);
      const sourceIdentity = identitiesByPath.get(from);
      identitiesByPath.delete(from);
      if (sourceIdentity !== undefined) identitiesByPath.set(to, sourceIdentity);
      if (symlinks.delete(from)) symlinks.add(to);
    },
    unlink: async (path: string): Promise<void> => {
      events.push(`unlink:${path}`);
      if (options.failBackupUnlink && path.includes(".management.state.backup-")) {
        throw new Error("injected backup cleanup failure");
      }
      if (options.backupUnlinkIsAmbiguouslyMissing && path.includes(".management.state.backup-")) {
        contentsByPath.delete(path);
        identitiesByPath.delete(path);
        throw missing(path);
      }
      contentsByPath.delete(path);
      identitiesByPath.delete(path);
      symlinks.delete(path);
    },
  };
};

const concurrentWriterFileSystem = (): {
  fileSystem: ManagementStateFileSystem;
  firstPromotionReady: Promise<void>;
  failFirstPromotion(): void;
  readonly targetContents: string | undefined;
} => {
  const target = "/opt/argus/management.state";
  const files = new Map<string, string>([[target, "previous state\n"]]);
  const identities = new Map<string, number>([[target, 1]]);
  let nextIdentity = 2;
  let signalFirstPromotion: (() => void) | undefined;
  const firstPromotionReady = new Promise<void>((resolve) => {
    signalFirstPromotion = resolve;
  });
  let releaseFirstPromotion: (() => void) | undefined;
  const firstPromotionFailure = new Promise<void>((resolve) => {
    releaseFirstPromotion = resolve;
  });
  let firstPromotionPending = true;
  const missing = (path: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}'`), {
      code: "ENOENT",
    });
  const exists = (path: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`EEXIST: file already exists, open '${path}'`), {
      code: "EEXIST",
    });
  const fileSystem: ManagementStateFileSystem = {
    lstat: async (path) => {
      if (!files.has(path)) throw missing(path);
      const ino = identities.get(path);
      if (ino === undefined) throw missing(path);
      return { dev: 1, ino, isSymbolicLink: () => false };
    },
    open: async (path, flags) => {
      if (path === "/opt/argus") {
        return {
          writeFile: async () => {
            throw new Error("directory cannot be written");
          },
          chmod: async () => {
            throw new Error("directory cannot be chmodded");
          },
          sync: async () => {
            if (firstPromotionPending && files.get(target) === valid) {
              firstPromotionPending = false;
              signalFirstPromotion?.();
              await firstPromotionFailure;
              throw new Error("injected first-writer parent sync failure");
            }
          },
          stat: async () => ({ dev: 1, ino: 0 }),
          close: async () => undefined,
        };
      }
      if (flags === "wx" && files.has(path)) throw exists(path);
      if (flags === "wx") {
        files.set(path, "");
        identities.set(path, nextIdentity);
        nextIdentity += 1;
      }
      return {
        writeFile: async (written: string) => {
          files.set(path, written);
        },
        chmod: async () => undefined,
        sync: async () => undefined,
        stat: async () => {
          const ino = identities.get(path);
          if (ino === undefined) throw missing(path);
          return { dev: 1, ino };
        },
        close: async () => undefined,
      };
    },
    rename: async (from, to) => {
      const source = files.get(from);
      if (source === undefined) throw missing(from);
      files.delete(from);
      files.set(to, source);
      const sourceIdentity = identities.get(from);
      identities.delete(from);
      if (sourceIdentity !== undefined) identities.set(to, sourceIdentity);
    },
    unlink: async (path) => {
      if (!files.delete(path)) throw missing(path);
      identities.delete(path);
    },
  };

  return {
    fileSystem,
    firstPromotionReady,
    failFirstPromotion: () => releaseFirstPromotion?.(),
    get targetContents() {
      return files.get(target);
    },
  };
};
