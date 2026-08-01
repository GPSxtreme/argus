#!/usr/bin/env node

import { readFileSync } from "node:fs";

const fail = (message) => {
  throw new Error(message);
};

const shaPattern = /^[a-f0-9]{40}$/u;
const tagPattern =
  /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$/u;

const argumentsByName = (values) => {
  if (values.length % 2 !== 0) fail("arguments must be option/value pairs");
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith("--") || !value || parsed.has(name)) {
      fail("invalid or duplicate argument");
    }
    parsed.set(name, value);
  }
  return parsed;
};

const exactArguments = (parsed, expected) => {
  if (
    parsed.size !== expected.length ||
    expected.some((name) => !parsed.has(name))
  ) {
    fail("unexpected source resolver arguments");
  }
};

const jsonFile = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("candidate metadata is not valid JSON");
  }
};

const timestamp = (value) => {
  if (typeof value !== "string") fail("candidate timestamp is missing");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail("candidate timestamp is invalid");
  return milliseconds;
};

const resolveWorkflowRun = (parsed) => {
  exactArguments(parsed, [
    "--workflow-run-sha",
    "--workflow-run-conclusion",
  ]);
  if (parsed.get("--workflow-run-conclusion") !== "success") {
    fail("signed release workflow did not succeed");
  }
  const sha = parsed.get("--workflow-run-sha");
  if (!shaPattern.test(sha)) fail("signed release workflow SHA is invalid");
  return sha;
};

const resolveManualDispatch = (parsed) => {
  exactArguments(parsed, [
    "--tag",
    "--release",
    "--runs",
    "--tag-commit",
  ]);
  const tag = parsed.get("--tag");
  if (!tagPattern.test(tag)) fail("release tag is invalid");
  const release = jsonFile(parsed.get("--release"));
  if (
    !release ||
    typeof release !== "object" ||
    release.tag_name !== tag
  ) {
    fail("release tag does not match requested tag");
  }
  if (release.draft !== false) fail("release is not published");
  const publishedAt = timestamp(release.published_at);
  const runs = jsonFile(parsed.get("--runs"));
  if (!runs || typeof runs !== "object" || !Array.isArray(runs.workflow_runs)) {
    fail("signed release workflow metadata is invalid");
  }
  const matching = runs.workflow_runs.filter((run) => {
    if (!run || typeof run !== "object") return false;
    if (
      run.path !== ".github/workflows/release.yml" ||
      run.event !== "push" ||
      run.conclusion !== "success" ||
      run.head_branch !== tag ||
      typeof run.head_sha !== "string" ||
      !shaPattern.test(run.head_sha)
    ) {
      return false;
    }
    try {
      return (
        timestamp(run.created_at) <= publishedAt &&
        timestamp(run.updated_at) >= publishedAt
      );
    } catch {
      return false;
    }
  });
  if (matching.length !== 1) {
    fail("no unique successful signed release run contains this publication");
  }
  const sourceSha = matching[0].head_sha;
  const tagCommit = jsonFile(parsed.get("--tag-commit"));
  if (
    !tagCommit ||
    typeof tagCommit !== "object" ||
    typeof tagCommit.sha !== "string" ||
    !shaPattern.test(tagCommit.sha)
  ) {
    fail("tag commit metadata is invalid");
  }
  if (tagCommit.sha !== sourceSha) {
    fail("tag commit does not match the signed release workflow commit");
  }
  return sourceSha;
};

try {
  const parsed = argumentsByName(process.argv.slice(2));
  const sourceSha = parsed.has("--workflow-run-sha")
    ? resolveWorkflowRun(parsed)
    : resolveManualDispatch(parsed);
  process.stdout.write(`${sourceSha}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`installer smoke source: ${message}\n`);
  process.exitCode = 1;
}
