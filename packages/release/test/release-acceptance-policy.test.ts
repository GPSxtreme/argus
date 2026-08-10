import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { renderArgusWrapper } from "../src/wrapper.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const policy = join(repositoryRoot, "scripts/e2e/release-acceptance-policy.mjs");
const temporaryDirectories: string[] = [];

const temporaryDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "argus-release-acceptance-policy-"));
  temporaryDirectories.push(directory);
  return directory;
};

const runPolicy = (arguments_: readonly string[]) =>
  spawnSync(process.execPath, [policy, ...arguments_], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("release acceptance policy", () => {
  it("uses bootstrap mode when no earlier release has a verified durable launcher", () => {
    const directory = temporaryDirectory();
    const durableTags = join(directory, "durable-tags.json");
    writeFileSync(durableTags, '["v0.1.15"]\n');

    const result = runPolicy([
      "select-baseline",
      "--target",
      "v0.1.14",
      "--durable-tags",
      durableTags,
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ mode: "bootstrap" });
  });

  it("uses the latest verified durable earlier release for the full update lifecycle", () => {
    const directory = temporaryDirectory();
    const durableTags = join(directory, "durable-tags.json");
    writeFileSync(durableTags, '["v0.1.13","v0.1.14","v0.1.9"]\n');

    const result = runPolicy([
      "select-baseline",
      "--target",
      "v0.1.15",
      "--durable-tags",
      durableTags,
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      mode: "update",
      baselineTag: "v0.1.14",
    });
  });

  it("accepts only a hash-bound launcher that declares the durable state contract", () => {
    const directory = temporaryDirectory();
    const wrapper = join(directory, "argus");
    const manifest = join(directory, "manifest.json");
    const wrapperBytes = Buffer.from(renderArgusWrapper());
    writeFileSync(wrapper, wrapperBytes);
    writeFileSync(
      manifest,
      JSON.stringify({
        assets: {
          wrapper: {
            sha256: createHash("sha256").update(wrapperBytes).digest("hex"),
          },
        },
      }),
    );

    const result = runPolicy(["verify-durable-launcher", manifest, wrapper]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ durable: true });
  });

  it("rejects a hash-bound legacy wrapper before it can become an update baseline", () => {
    const directory = temporaryDirectory();
    const wrapper = join(directory, "argus");
    const manifest = join(directory, "manifest.json");
    const wrapperBytes = Buffer.from(`#!/bin/sh\nargus_version='0.1.13'\n`);
    writeFileSync(wrapper, wrapperBytes);
    writeFileSync(
      manifest,
      JSON.stringify({
        assets: {
          wrapper: {
            sha256: createHash("sha256").update(wrapperBytes).digest("hex"),
          },
        },
      }),
    );

    const result = runPolicy(["verify-durable-launcher", manifest, wrapper]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ durable: false });
  });

  it("fails closed when the candidate wrapper does not match its manifest", () => {
    const directory = temporaryDirectory();
    const wrapper = join(directory, "argus");
    const manifest = join(directory, "manifest.json");
    writeFileSync(wrapper, renderArgusWrapper());
    writeFileSync(
      manifest,
      JSON.stringify({
        assets: { wrapper: { sha256: "0".repeat(64) } },
      }),
    );

    const result = runPolicy(["verify-durable-launcher", manifest, wrapper]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not match its manifest SHA-256");
  });
});
