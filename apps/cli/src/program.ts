import {
  constants as fsConstants,
  readFileSync,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  type ArgusConfig,
  loadConfig,
  resolveConfigPath,
} from "@argus/config";
import {
  applyUpdate,
  type CommandExecutor,
  createArgusDoctorApi,
  DeploymentError,
  type DiagnosticReport,
  finalizeUpdate,
  getDeploymentStatus,
  inspectHost,
  loadDeploymentState,
  type OnboardingAnswersV1,
  onboardingAnswersSchema,
  planUpdate,
  repairService,
  restartDeployment,
  rollbackUpdate,
  runDoctor,
  MANAGEMENT_WRAPPER_REQUIREMENTS as SHARED_MANAGEMENT_WRAPPER_REQUIREMENTS,
  startDeployment,
  stopDeployment,
  type UpdatePlan,
} from "@argus/deployment";
import { targetsFromConfig } from "@argus/scheduler";
import { Command, CommanderError } from "commander";
import { parse } from "yaml";
import { z } from "zod";
import type { ProductionUpdateIntegration } from "./integrations.js";
import {
  renderHumanConfig,
  renderHumanDoctor,
  renderHumanLogs,
  renderHumanPlan,
  renderHumanStatus,
  humanServiceStates,
} from "./human.js";
import { selectMenuInvocation } from "./menu.js";
import {
  CliExitError,
  type CliIO,
  redactValue,
  replaceSecrets,
  writeFailure,
  writeSuccess,
} from "./output.js";
import {
  collectOnboarding,
  collectRequiredSecrets,
  type PromptAdapter,
} from "./prompts.js";

export interface DeploymentCliAdapter {
  inspectLifecycle(action: "start" | "stop" | "restart"): Promise<unknown>;
  applyLifecycle(action: "start" | "stop" | "restart"): Promise<unknown>;
  verifyLifecycle(action: "start" | "stop" | "restart"): Promise<unknown>;
  status(): Promise<unknown>;
  logs(
    service: string | undefined,
    options: { tail: number; timeoutMs: number },
  ): Promise<string>;
  doctor(): Promise<DiagnosticReport>;
  inspectRepair(service: string): Promise<unknown>;
  applyRepair(service: string): Promise<unknown>;
  verifyRepair(service: string, applied?: unknown): Promise<unknown>;
  inspectUpdate?(): Promise<unknown>;
  applyUpdate?(inspection: unknown): Promise<unknown>;
  verifyUpdate?(applied?: unknown): Promise<unknown>;
  inspectRollbackUpdate?(): Promise<unknown>;
  applyRollbackUpdate?(inspection: unknown): Promise<unknown>;
  inspectOnboarding(
    answers: OnboardingAnswersV1,
    secrets: Readonly<Record<string, string>>,
  ): Promise<unknown>;
  applyOnboarding(
    answers: OnboardingAnswersV1,
    secrets: Readonly<Record<string, string>>,
    inspection: unknown,
  ): Promise<unknown>;
  verifyOnboarding(
    answers: OnboardingAnswersV1,
    applied?: unknown,
  ): Promise<unknown>;
}

export interface VerifiedOnboardingRelease {
  version: string;
  manifestSha256: string;
  images: {
    argus: `${string}@sha256:${string}`;
    postgres: `${string}@sha256:${string}`;
    searxng: `${string}@sha256:${string}`;
  };
  fxembed?: {
    bundleSha256: string;
    compatibilityDate: string;
  };
}

export interface ReleaseOnboardingInspection {
  plan: unknown;
  release: VerifiedOnboardingRelease;
}

export interface ReleaseOnboardingApplication {
  receipt: unknown;
  release: VerifiedOnboardingRelease;
  stateWritten: boolean;
}

/** Signed-release integration supplied by release Tasks 1–5. */
export interface ProductionOnboardingIntegration {
  inspect(input: {
    answers: OnboardingAnswersV1;
    secrets: Readonly<Record<string, string>>;
  }): Promise<ReleaseOnboardingInspection>;
  apply(input: {
    answers: OnboardingAnswersV1;
    secrets: Readonly<Record<string, string>>;
    inspection: ReleaseOnboardingInspection;
  }): Promise<ReleaseOnboardingApplication>;
  verify(input: {
    answers: OnboardingAnswersV1;
    application: ReleaseOnboardingApplication;
  }): Promise<{
    healthy: boolean;
    release: VerifiedOnboardingRelease;
    status: unknown;
  }>;
}

export interface CliFiles {
  readText(path: string): Promise<string>;
  stat(path: string): Promise<{ mode: number }>;
  writeSecret(name: string, value: string): Promise<void>;
}

export interface ConfigCliAdapter {
  validate(path?: string): Promise<unknown>;
  inspectApply(path?: string): Promise<unknown>;
  apply(path: string | undefined, inspection: unknown): Promise<unknown>;
  verifyApply(
    path: string | undefined,
    inspection: unknown,
    application: unknown,
  ): Promise<unknown>;
  show(path?: string): Promise<unknown>;
}

export interface InstalledConfigPlan {
  contractVersion: 1;
  planId: string;
  path: string;
  baseContentHash?: string;
  desiredContentHash: string;
  operations: Array<{
    resource: string;
    action: "create" | "update" | "delete";
    summary: string;
  }>;
}

export interface InstalledConfigApplication {
  planId: string;
  receipt: unknown;
}

export interface InstalledConfigIntegration {
  inspect(input: {
    path: string;
    config: ArgusConfig;
  }): Promise<InstalledConfigPlan>;
  apply(input: {
    path: string;
    config: ArgusConfig;
    inspection: InstalledConfigPlan;
  }): Promise<InstalledConfigApplication>;
  verify(input: {
    path: string;
    inspection: InstalledConfigPlan;
    application: InstalledConfigApplication;
  }): Promise<{ healthy: boolean; planId: string; status: unknown }>;
}

export interface CliDependencies {
  deployment: DeploymentCliAdapter;
  prompt: PromptAdapter;
  io: CliIO;
  files: CliFiles;
  config: ConfigCliAdapter;
  root: string;
  version?: string;
  interactive?: boolean;
  secretValues(): Promise<Record<string, string>>;
}

interface CommonOptions {
  json?: boolean;
}

interface MutationOptions extends CommonOptions {
  yes?: boolean;
  dryRun?: boolean;
}

const secretKeyPattern =
  /(?:^|_)(?:secret|token|password|passphrase|api_?key|authorization)(?:$|_)/iu;

const isSecretKey = (key: string): boolean => {
  const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
  return (
    secretKeyPattern.test(key) ||
    ["secret", "token", "password", "passphrase", "apikey", "authorization"].some(
      (suffix) => normalized === suffix || normalized.endsWith(suffix),
    )
  );
};

const rejectSecretFields = (value: unknown, path: string[] = []): void => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      rejectSecretFields(entry, [...path, String(index)]);
    });
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretKey(key)) {
      throw new DeploymentError(
        "ONBOARDING_FILE_CONTAINS_SECRET",
        `The onboarding answers file contains a forbidden secret field at ${[
          ...path,
          key,
        ].join(".")}.`,
        {
          recovery:
            "Remove secret fields. Argus will request required secrets through hidden prompts.",
        },
      );
    }
    rejectSecretFields(entry, [...path, key]);
  }
};

const readOnboardingAnswers = async (
  path: string,
  files: CliFiles,
): Promise<OnboardingAnswersV1> => {
  const metadata = await files.stat(resolve(path)).catch(() => undefined);
  if (metadata !== undefined && (metadata.mode & 0o022) !== 0) {
    throw new DeploymentError(
      "ONBOARDING_FILE_MODE_UNSAFE",
      "The onboarding answers file must not be group- or world-writable.",
      {
        recovery:
          "Remove group and world write permissions from the answers file, then retry.",
      },
    );
  }
  let document: unknown;
  try {
    document = parse(await files.readText(resolve(path)));
  } catch {
    throw new DeploymentError(
      "ONBOARDING_FILE_INVALID",
      "The onboarding answers file could not be read as YAML.",
      { recovery: "Correct the YAML file and retry onboarding." },
    );
  }
  rejectSecretFields(document);
  const parsed = onboardingAnswersSchema.safeParse(document);
  if (!parsed.success) {
    throw new DeploymentError(
      "ONBOARDING_ANSWERS_INVALID",
      "The onboarding answers file does not match the version 1 schema.",
      {
        recovery:
          "Run 'argus config schema --json' and correct the answers file.",
      },
    );
  }
  return parsed.data as OnboardingAnswersV1;
};

const confirmationRequired = (): DeploymentError =>
  new DeploymentError(
    "CONFIRMATION_REQUIRED",
    "This command changes the Argus instance and requires confirmation.",
    {
      recovery:
        "Rerun the same command with --dry-run to inspect its plan, then rerun with --yes.",
    },
  );

const confirmMutation = async (
  dependencies: CliDependencies,
  prompt: PromptAdapter,
  options: MutationOptions,
  message: string,
  plan: unknown,
  additionalSecrets: readonly string[] = [],
): Promise<void> => {
  if (options.yes) return;
  if (options.json || dependencies.interactive !== true) {
    throw confirmationRequired();
  }
  const secrets = [
    ...(await secretList(dependencies).catch(() => [])),
    ...additionalSecrets,
  ];
  dependencies.io.stdout(
    `${renderHumanPlan(redactValue(plan, secrets))}\n`,
  );
  if (!(await prompt.confirm({ message, initialValue: false }))) {
    throw confirmationRequired();
  }
};

const secretList = async (dependencies: CliDependencies): Promise<string[]> =>
  Object.values(await dependencies.secretValues()).filter(Boolean);

const execute = async (
  dependencies: CliDependencies,
  options: CommonOptions,
  operation: () => Promise<{ data: unknown; human: string }>,
  additionalSecrets: () => readonly string[] = () => [],
): Promise<void> => {
  try {
    const result = await operation();
    const secrets = [
      ...(await secretList(dependencies)),
      ...additionalSecrets(),
    ];
    writeSuccess(
      dependencies.io,
      options.json === true,
      redactValue(result.data, secrets),
      replaceSecrets(result.human, secrets),
    );
  } catch (error) {
    const secrets = [
      ...(await secretList(dependencies).catch(() => [])),
      ...additionalSecrets(),
    ];
    throw writeFailure(
      dependencies.io,
      options.json === true,
      error,
      secrets,
    );
  }
};

const commonOptions = (command: Command): Command =>
  command.option("--json", "emit the stable versioned JSON contract");

const mutationOptions = (command: Command): Command =>
  commonOptions(command).option(
    "-y, --yes",
    "apply the inspected plan without an interactive confirmation",
  ).option("--dry-run", "inspect and print the plan without applying changes");

export const onboardingJsonSchema = (): Record<string, unknown> => {
  const base = z.toJSONSchema(onboardingAnswersSchema) as Record<
    string,
    unknown
  >;
  const managedEquals = (property: "searxng" | "fxembed", value: string) => ({
    properties: {
      managed: {
        properties: { [property]: { const: value } },
        required: [property],
      },
    },
    required: ["managed"],
  });
  const conditional = (condition: unknown, consequence: unknown) =>
    Object.fromEntries([
      ["if", condition],
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema requires the standard `then` keyword.
      ["then", consequence],
    ]);
  return {
    ...base,
    allOf: [
      conditional(managedEquals("fxembed", "managed"), {
          required: ["cloudflare"],
          properties: {
            cloudflare: { required: ["accountId"] },
          },
        }),
      conditional(managedEquals("searxng", "external"), {
          required: ["external"],
          properties: {
            external: { required: ["searxngEndpoint"] },
          },
        }),
      conditional(managedEquals("fxembed", "external"), {
          required: ["external"],
          properties: {
            external: { required: ["fxembedEndpoint"] },
          },
        }),
    ],
  };
};

const lifecycleCommand = (
  program: Command,
  dependencies: CliDependencies,
  action: "start" | "stop" | "restart",
): void => {
  mutationOptions(
    program.command(action).description(`${action} the Argus deployment`),
  ).action(async (options: MutationOptions) => {
    await execute(dependencies, options, async () => {
      const plan = await dependencies.deployment.inspectLifecycle(action);
      if (options.dryRun) {
        return { data: { plan }, human: renderHumanPlan(plan) };
      }
      await confirmMutation(
        dependencies,
        dependencies.prompt,
        options,
        `${action} Argus using the inspected plan?`,
        plan,
      );
      await dependencies.deployment.applyLifecycle(action);
      const verified = await dependencies.deployment.verifyLifecycle(action);
      return {
        data: { plan, result: verified },
        human: `Argus ${action} completed and was verified.`,
      };
    });
  });
};

const registerConfig = (
  program: Command,
  dependencies: CliDependencies,
): void => {
  const config = program
    .command("config")
    .description("Manage Argus configuration");
  config.action(() => {
    if (config.optsWithGlobals().json === true) {
      throw new DeploymentError(
        "CLI_USAGE_ERROR",
        "The command arguments are invalid.",
        { recovery: "Run 'argus --help' to inspect valid commands." },
      );
    }
    const help = config.helpInformation().trimEnd();
    writeSuccess(
      dependencies.io,
      config.optsWithGlobals().json === true,
      { help },
      help,
    );
  });

  commonOptions(
    config
      .command("schema")
      .description("Print the versioned onboarding answers JSON Schema"),
  ).action(async (options: CommonOptions) => {
    await execute(dependencies, options, async () => {
      const schema = onboardingJsonSchema();
      return { data: schema, human: JSON.stringify(schema, null, 2) };
    });
  });

  commonOptions(
    config
      .command("validate")
      .argument("[path]", "configuration path")
      .description("Validate an Argus runtime configuration"),
  ).action(async (path: string | undefined, options: CommonOptions) => {
    await execute(dependencies, options, async () => ({
      data: await dependencies.config.validate(path),
      human: "Configuration is valid.",
    }));
  });

  mutationOptions(
    config
      .command("apply")
      .argument("[path]", "configuration path")
      .description("Apply an Argus runtime configuration"),
  ).action(
    async (path: string | undefined, options: MutationOptions) => {
      await execute(dependencies, options, async () => {
        const plan = await dependencies.config.inspectApply(path);
        if (options.dryRun) {
          return { data: { plan }, human: renderHumanPlan(plan) };
        }
        await confirmMutation(
          dependencies,
          dependencies.prompt,
          options,
          "Apply the validated configuration?",
          plan,
        );
        const applied = await dependencies.config.apply(path, plan);
        const verified = await dependencies.config.verifyApply(
          path,
          plan,
          applied,
        );
        return {
          data: { plan, result: applied, verification: verified },
          human: "Configuration applied.",
        };
      });
    },
  );

  commonOptions(
    config
      .command("show")
      .argument("[path]", "configuration path")
      .description("Show the active configuration with secrets redacted"),
  ).action(async (path: string | undefined, options: CommonOptions) => {
    await execute(dependencies, options, async () => {
      const shown = await dependencies.config.show(path);
      return {
        data: shown,
        human: renderHumanConfig(shown),
      };
    });
  });
};

const registerSecrets = (
  program: Command,
  dependencies: CliDependencies,
): void => {
  const secrets = program
    .command("secrets")
    .description("Manage instance secrets without exposing values");
  secrets.action(() => {
    if (secrets.optsWithGlobals().json === true) {
      throw new DeploymentError(
        "CLI_USAGE_ERROR",
        "The command arguments are invalid.",
        { recovery: "Run 'argus --help' to inspect valid commands." },
      );
    }
    const help = secrets.helpInformation().trimEnd();
    writeSuccess(
      dependencies.io,
      secrets.optsWithGlobals().json === true,
      { help },
      help,
    );
  });
  mutationOptions(
    secrets
      .command("set")
      .argument("<name>", "environment-style secret name")
      .description("Set one secret using a hidden prompt"),
  ).action(async (name: string, options: MutationOptions) => {
    let ephemeralSecret = "";
    await execute(dependencies, options, async () => {
      if (!/^[A-Z][A-Z0-9_]*$/u.test(name) || !secretKeyPattern.test(name)) {
        throw new DeploymentError(
          "SECRET_NAME_INVALID",
          "Secret names must be uppercase environment names describing a secret.",
        );
      }
      const exists = Object.hasOwn(
        await dependencies.secretValues(),
        name,
      );
      const plan = { name, action: exists ? "update" : "create" };
      if (options.dryRun) {
        return { data: { plan }, human: renderHumanPlan(plan) };
      }
      await confirmMutation(
        dependencies,
        dependencies.prompt,
        options,
        `${exists ? "Update" : "Create"} ${name} in the owner-only instance secrets file?`,
        plan,
      );
      const value = await dependencies.prompt.secret({
        message: `Value for ${name}`,
      });
      ephemeralSecret = value;
      await dependencies.files.writeSecret(name, value);
      const verified = (await dependencies.secretValues())[name] === value;
      if (!verified) {
        throw new DeploymentError(
          "SECRET_VERIFY_FAILED",
          "The secret write could not be verified.",
          { recovery: "Retry 'argus secrets set' for the named secret." },
        );
      }
      return {
        data: {
          plan: {
            ...plan,
          },
          result: { name, updated: true },
        },
        human: `${name} was stored securely.`,
      };
    }, () => [ephemeralSecret]);
  });
};

export const createProgram = (dependencies: CliDependencies): Command => {
  let capturedOutput = "";
  const program = new Command()
    .name("argus")
    .description("Self-hosted data layer for X, Telegram, and the Web")
    .version(dependencies.version ?? resolveCliBuildVersion())
    .option("--json", "emit the stable versioned JSON contract")
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut(value) {
        capturedOutput += value;
      },
      writeErr() {
        // Parser errors are rendered through the stable boundary below.
      },
    });
  program.hook("preAction", (_root, action) => {
    if (program.opts().json === true) action.setOptionValue("json", true);
  });

  mutationOptions(
    program
      .command("onboard")
      .description("Interactively configure and reconcile an Argus VPS")
      .option("--from <path>", "read strict non-secret YAML answers"),
  ).action(
    async (
      options: MutationOptions & { from?: string },
    ): Promise<void> => {
      let ephemeralSecrets: string[] = [];
      await execute(dependencies, options, async () => {
        const collected =
          options.from === undefined
            ? await collectOnboarding(dependencies.prompt)
            : {
                answers: await readOnboardingAnswers(
                  options.from,
                  dependencies.files,
                ),
                secrets: undefined,
              };
        const answers = onboardingAnswersSchema.parse(
          collected.answers,
        ) as OnboardingAnswersV1;
        let secrets = collected.secrets;
        if (secrets === undefined) {
          if (
            options.dryRun ||
            (options.json && !options.yes) ||
            (dependencies.interactive !== true && !options.yes)
          ) {
            secrets = {};
          } else if (dependencies.interactive !== true) {
            throw new DeploymentError(
              "SECRET_INPUT_REQUIRED",
              "Required onboarding secrets must be entered from an interactive terminal.",
              {
                recovery:
                  "Run onboarding from a TTY and enter secrets through hidden prompts.",
              },
            );
          } else {
            secrets = await collectRequiredSecrets(
              answers,
              dependencies.prompt,
            );
          }
        }
        ephemeralSecrets = Object.values(secrets);
        const plan = await dependencies.deployment.inspectOnboarding(
          answers,
          secrets,
        );
        if (options.dryRun) {
          return { data: { plan }, human: renderHumanPlan(plan) };
        }
        await confirmMutation(
          dependencies,
          dependencies.prompt,
          options,
          "Apply and verify this Argus VPS plan?",
          plan,
          Object.values(secrets),
        );
        const applied = await dependencies.deployment.applyOnboarding(
          answers,
          secrets,
          plan,
        );
        const verified = await dependencies.deployment.verifyOnboarding(
          answers,
          applied,
        );
        return {
          data: { plan, result: verified },
          human:
            "Argus onboarding completed. Secrets remain in /opt/argus/secrets.env.",
        };
      }, () => ephemeralSecrets);
    },
  );

  lifecycleCommand(program, dependencies, "start");
  lifecycleCommand(program, dependencies, "stop");
  lifecycleCommand(program, dependencies, "restart");

  commonOptions(
    program.command("status").description("Inspect Argus service status"),
  ).action(async (options: CommonOptions) => {
    await execute(dependencies, options, async () => {
      const status = await dependencies.deployment.status();
      return { data: status, human: renderHumanStatus(status) };
    });
  });

  commonOptions(
    program
      .command("logs")
      .argument("[service]", "argus, postgres, or searxng")
      .option("--tail <lines>", "maximum log lines", "200")
      .option("--raw", "show the exact bounded service output")
      .description("Read bounded service logs"),
  ).action(
    async (
      service: string | undefined,
      options: CommonOptions & { tail: string; raw?: boolean },
    ) => {
      await execute(dependencies, options, async () => {
        if (!/^[1-9]\d*$/u.test(options.tail)) {
          throw new DeploymentError(
            "LOG_TAIL_INVALID",
            "Log tail must be a positive integer no greater than 10000.",
          );
        }
        const tail = Number(options.tail);
        if (!Number.isSafeInteger(tail) || tail > 10_000) {
          throw new DeploymentError(
            "LOG_TAIL_INVALID",
            "Log tail must be a positive integer no greater than 10000.",
          );
        }
        const logs = await dependencies.deployment.logs(service, {
          tail,
          timeoutMs: 30_000,
        });
        return {
          data: { service: service ?? "all", logs },
          human: options.raw ? logs : renderHumanLogs(logs),
        };
      });
    },
  );

  commonOptions(
    program.command("doctor").description("Run bounded Argus diagnostics"),
  ).action(async (options: CommonOptions) => {
    await execute(dependencies, options, async () => {
      const report = await dependencies.deployment.doctor();
      return {
        data: report,
        human: renderHumanDoctor(report),
      };
    });
  });

  mutationOptions(
    program
      .command("repair")
      .argument("<service>", "argus, postgres, or searxng")
      .description("Perform a targeted managed-service repair"),
  ).action(async (service: string, options: MutationOptions) => {
    await execute(dependencies, options, async () => {
      if (!["argus", "postgres", "searxng"].includes(service)) {
        throw new DeploymentError(
          "REPAIR_SERVICE_INVALID",
          "Repair supports argus, postgres, or searxng only.",
        );
      }
      const plan = await dependencies.deployment.inspectRepair(service);
      if (options.dryRun) {
        return { data: { plan }, human: renderHumanPlan(plan) };
      }
      await confirmMutation(
        dependencies,
        dependencies.prompt,
        options,
        `Apply the targeted ${service} repair?`,
        plan,
      );
      const applied = await dependencies.deployment.applyRepair(service);
      const verified = await dependencies.deployment.verifyRepair(
        service,
        applied,
      );
      return {
        data: { plan, result: verified },
        human: `${service} repair completed and was verified.`,
      };
    });
  });

  mutationOptions(
    program.command("update").description("Update Argus to a verified signed release"),
  ).option("--rollback", "roll back to the persisted verified release backup").action(async (options: MutationOptions & { rollback?: boolean }) => {
    await execute(dependencies, options, async () => {
      if (options.rollback) {
        if (
          dependencies.deployment.inspectRollbackUpdate === undefined ||
          dependencies.deployment.applyRollbackUpdate === undefined
        ) {
          throw new DeploymentError("UPDATE_ROLLBACK_UNAVAILABLE", "Argus rollback support is unavailable in this CLI environment.");
        }
        const plan = await dependencies.deployment.inspectRollbackUpdate();
        if (options.dryRun) return { data: { plan }, human: renderHumanPlan(plan) };
        await confirmMutation(
          dependencies,
          dependencies.prompt,
          options,
          "Roll back Argus using the persisted verified release backup?",
          plan,
        );
        const applied = await dependencies.deployment.applyRollbackUpdate(plan);
        const result = applied as { version?: unknown; health?: unknown };
        return {
          data: { version: result.version, health: result.health },
          human: `Argus rollback to ${String(result.version ?? "the verified backup")} completed.`,
        };
      }
      if (
        dependencies.deployment.inspectUpdate === undefined ||
        dependencies.deployment.applyUpdate === undefined ||
        dependencies.deployment.verifyUpdate === undefined
      ) {
        throw new DeploymentError(
          "UPDATE_UNAVAILABLE",
          "Argus update support is unavailable in this CLI environment.",
          { recovery: "Use an Argus CLI installed from a signed release, then retry." },
        );
      }
      const plan = await dependencies.deployment.inspectUpdate();
      if (options.dryRun) {
        return { data: { plan }, human: renderHumanPlan(plan) };
      }
      await confirmMutation(
        dependencies,
        dependencies.prompt,
        options,
        "Update Argus using the inspected signed release plan?",
        plan,
      );
      const applied = await dependencies.deployment.applyUpdate(plan);
      const health = await dependencies.deployment.verifyUpdate(applied);
      const result = applied as { version?: unknown };
      return {
        data: { version: result.version, health },
        human: `Argus ${String(result.version ?? "update")} completed and was verified.`,
      };
    });
  });

  registerConfig(program, dependencies);
  registerSecrets(program, dependencies);

  program.action(async () => {
    const help = program.helpInformation().trimEnd();
    if (program.opts().json === true || dependencies.interactive !== true) {
      writeSuccess(
        dependencies.io,
        program.opts().json === true,
        { help },
        help,
      );
      return;
    }

    const command = await selectMenuInvocation(dependencies.prompt);
    if (command === null) {
      writeSuccess(dependencies.io, false, { exited: true }, "Goodbye.");
      return;
    }
    await createProgram(dependencies).parseAsync(["node", "argus", ...command]);
  });

  const commanderParseAsync = program.parseAsync.bind(program);
  program.parseAsync = async (argv, parseOptions) => {
    const argumentsList = argv ?? process.argv;
    const json = argumentsList.includes("--json");
    const normalized = json
      ? [
          ...argumentsList.slice(0, 2),
          "--json",
          ...argumentsList.slice(2).filter((entry) => entry !== "--json"),
        ]
      : argumentsList;
    capturedOutput = "";
    try {
      return await commanderParseAsync(normalized, parseOptions);
    } catch (error) {
      if (error instanceof CliExitError) throw error;
      const secrets = await secretList(dependencies).catch(() => []);
      if (
        error instanceof CommanderError &&
        (error.code === "commander.helpDisplayed" ||
          error.code === "commander.version")
      ) {
        const output = capturedOutput.trimEnd();
        writeSuccess(
          dependencies.io,
          json,
          error.code === "commander.version"
            ? { version: output }
            : { help: output },
          output,
        );
        return program;
      }
      const stable =
        error instanceof DeploymentError
          ? error
          : new DeploymentError(
              "CLI_USAGE_ERROR",
              "The command arguments are invalid.",
              { recovery: "Run 'argus --help' to inspect valid commands." },
            );
      throw writeFailure(dependencies.io, json, stable, secrets);
    }
  };
  return program;
};

const parseSecrets = (contents: string): Record<string, string> =>
  Object.fromEntries(
    contents.split(/\r?\n/u).flatMap((line) => {
      if (!line || line.trimStart().startsWith("#")) return [];
      const separator = line.indexOf("=");
      if (separator < 1) return [];
      return [[line.slice(0, separator), line.slice(separator + 1)]];
    }),
  );

const readSecretsFile = async (
  root: string,
): Promise<Record<string, string>> => {
  const path = join(root, "secrets.env");
  try {
    const linkMetadata = await lstat(path);
    const handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    let contents = "";
    try {
      const metadata = await handle.stat();
      const expectedOwner = process.geteuid?.();
      if (
        linkMetadata.isSymbolicLink() ||
        !metadata.isFile() ||
        linkMetadata.dev !== metadata.dev ||
        linkMetadata.ino !== metadata.ino ||
        (metadata.mode & 0o777) !== 0o600 ||
        (expectedOwner !== undefined && metadata.uid !== expectedOwner)
      ) {
        throw new DeploymentError(
          "SECRETS_FILE_UNSAFE",
          "The instance secrets file must be a regular owner-owned file with mode 0600.",
          {
            recovery:
              "Replace the secrets file with a regular owner-owned mode-0600 file, then retry.",
          },
        );
      }
      contents = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    return parseSecrets(contents);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new DeploymentError(
        "SECRETS_FILE_UNSAFE",
        "The instance secrets file must be a regular owner-owned file with mode 0600.",
        {
          recovery:
            "Replace the secrets file with a regular owner-owned mode-0600 file, then retry.",
        },
      );
    }
    throw error;
  }
};

const atomicSecretWrite = async (
  root: string,
  name: string,
  value: string,
): Promise<void> => {
  if (/[\r\n]/u.test(value)) {
    throw new DeploymentError(
      "SECRET_VALUE_INVALID",
      "Secret values cannot contain line breaks.",
    );
  }
  const path = join(root, "secrets.env");
  await mkdir(root, { recursive: true, mode: 0o755 });
  const existing = await readSecretsFile(root);
  existing[name] = value;
  const contents = `${Object.entries(existing)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${key}=${entry}`)
    .join("\n")}\n`;
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

const installedConfigPath = (root: string, path?: string): string =>
  path === undefined ? join(root, "argus.yaml") : resolveConfigPath({ explicitPath: path });

const referencedEnvironment = async (
  path: string,
  environment: Record<string, string | undefined>,
): Promise<Record<string, string>> => {
  const contents = await readFile(path, "utf8");
  const names = new Set(
    [...contents.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/gu)].map(
      (match) => match[1] as string,
    ),
  );
  return Object.fromEntries(
    [...names].flatMap((name) => {
      const value = environment[name];
      return value ? [[name, value]] : [];
    }),
  );
};

const loadInstalledConfig = async (root: string, path?: string) => {
  const resolved = installedConfigPath(root, path);
  const fileSecrets = await readSecretsFile(root);
  const environment = { ...process.env, ...fileSecrets };
  const referenced = await referencedEnvironment(resolved, environment);
  return {
    path: resolved,
    config: await loadConfig(resolved, environment),
    secretEnvironment: { ...fileSecrets, ...referenced },
  };
};

const structurallyRedactConfig = (
  config: Awaited<ReturnType<typeof loadInstalledConfig>>["config"],
  secrets: readonly string[],
): unknown => {
  const redacted = redactValue(structuredClone(config), secrets) as typeof config;
  const redactCredentials = (value: string): string => {
    try {
      const url = new URL(value);
      if (url.username) url.username = "[REDACTED]";
      if (url.password) url.password = "[REDACTED]";
      return url.toString();
    } catch {
      return value;
    }
  };
  if (redacted.api.token !== undefined) redacted.api.token = "[REDACTED]";
  if (redacted.intelligence.apiKey !== undefined) {
    redacted.intelligence.apiKey = "[REDACTED]";
  }
  redacted.storage.url = redactCredentials(redacted.storage.url);
  redacted.sources.x.endpoint = redactCredentials(
    redacted.sources.x.endpoint,
  );
  if (redacted.sources.web.searchEndpoint !== undefined) {
    redacted.sources.web.searchEndpoint = redactCredentials(
      redacted.sources.web.searchEndpoint,
    );
  }
  return redacted;
};

export interface NodeCliDependenciesOptions {
  root: string;
  executor: CommandExecutor;
  prompt: PromptAdapter;
  io: CliIO;
  onboardingIntegration?: ProductionOnboardingIntegration;
  installedConfigIntegration?: InstalledConfigIntegration;
  updateIntegration?: ProductionUpdateIntegration;
  version?: string;
}

export const MANAGEMENT_HOST_PATHS = {
  osRelease: "/host/etc/os-release",
  meminfo: "/host/proc/meminfo",
  diskRoot: "/opt/argus",
} as const;

export const MANAGEMENT_WRAPPER_REQUIREMENTS =
  SHARED_MANAGEMENT_WRAPPER_REQUIREMENTS;

export const resolveCliBuildVersion = (
  environment: Record<string, string | undefined> = process.env,
): string => {
  const injected = environment.ARGUS_VERSION ?? environment.npm_package_version;
  if (injected) return injected;
  for (const candidate of [
    new URL("../package.json", import.meta.url),
    new URL("../../package.json", import.meta.url),
  ]) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
        version?: unknown;
      };
      if (typeof parsed.version === "string" && parsed.version) {
        return parsed.version;
      }
    } catch {
      // Try the source-tree and built-layout package metadata locations.
    }
  }
  throw new DeploymentError(
    "CLI_VERSION_UNAVAILABLE",
    "Argus build version metadata is unavailable.",
  );
};

const createDeploymentAdapter = (
  root: string,
  executor: CommandExecutor,
  onboardingIntegration?: ProductionOnboardingIntegration,
  updateIntegration?: ProductionUpdateIntegration,
): DeploymentCliAdapter => {
  const context = { root, executor };
  const doctorContext = async () => {
    const { config } = await loadInstalledConfig(root);
    const state = await loadDeploymentState(root);
    const targets = targetsFromConfig(config);
    const diagnosticTargetIds = Object.fromEntries(
      (["x", "telegram", "web"] as const).flatMap((source) => {
        const selected = targets.find((target) => target.source === source);
        return selected === undefined ? [] : [[source, selected.id]];
      }),
    );
    const searxngEndpoint = config.sources.web.searchEndpoint;
    const token = config.api.token;
    if (!token) {
      throw new DeploymentError(
        "API_TOKEN_UNAVAILABLE",
        "The Argus API token is unavailable for authenticated diagnostics.",
        {
          recovery:
            "Set ARGUS_API_TOKEN through 'argus secrets set ARGUS_API_TOKEN', then retry.",
        },
      );
    }
    return {
      root,
      executor,
      api: createArgusDoctorApi({
        endpoint: `http://127.0.0.1:${config.api.port}`,
        token,
      }),
      storage: config.storage.adapter,
      managed: {
        searxng:
          !config.sources.web.enabled || searxngEndpoint === undefined
            ? ("disabled" as const)
            : searxngEndpoint === "http://searxng:8080"
              ? ("managed" as const)
              : ("external" as const),
        fxembed:
          !config.sources.x.enabled
            ? ("disabled" as const)
            : state?.fxembed !== undefined
              ? ("managed" as const)
              : ("external" as const),
      },
      sources: {
        x: config.sources.x.enabled,
        telegram: config.sources.telegram.enabled,
        web: config.sources.web.enabled,
      },
      diagnosticTargetIds,
      ...(searxngEndpoint === undefined ? {} : { searxngEndpoint }),
    };
  };
  const lifecycle = {
    start: startDeployment,
    stop: stopDeployment,
    restart: restartDeployment,
  } as const;
  const sameRelease = (
    left: VerifiedOnboardingRelease,
    right: VerifiedOnboardingRelease,
  ): boolean => JSON.stringify(left) === JSON.stringify(right);
  return {
    async inspectLifecycle(action) {
      const current = await getDeploymentStatus(context);
      return {
        contractVersion: 1,
        changes: [
          {
            component: "argus",
            action,
            summary: `${action} the selected Argus services.`,
            external: false,
          },
        ],
        current,
      };
    },
    async applyLifecycle(action) {
      await lifecycle[action](context);
    },
    async verifyLifecycle() {
      return getDeploymentStatus(context);
    },
    async status() {
      const status = await getDeploymentStatus(context);
      const result = {
        state: status.healthy ? "running" : "degraded",
        services: Object.fromEntries(
          status.services.map((service) => [
            service.name,
            service.health || service.state,
          ]),
        ),
      };
      Object.defineProperty(result, humanServiceStates, {
        value: Object.fromEntries(
          status.services.map((service) => [service.name, service.state]),
        ),
      });
      return result;
    },
    async logs(service, options) {
      if (
        service !== undefined &&
        !["argus", "postgres", "searxng"].includes(service)
      ) {
        throw new DeploymentError(
          "LOG_SERVICE_INVALID",
          "Logs supports argus, postgres, or searxng only.",
        );
      }
      const result = await executor.run(
        "docker",
        [
          "compose",
          "-p",
          "argus",
          "logs",
          "--no-color",
          "--tail",
          String(options.tail),
          ...(service ? [service] : []),
        ],
        { cwd: root, timeoutMs: options.timeoutMs },
      );
      if (result.exitCode !== 0 || result.timedOut) {
        throw new DeploymentError(
          "LOGS_FAILED",
          "Bounded Argus service logs could not be read.",
        );
      }
      return result.stdout;
    },
    async doctor() {
      return runDoctor(await doctorContext());
    },
    async inspectRepair(service) {
      const current = await getDeploymentStatus(context);
      return {
        contractVersion: 1,
        changes: [
          {
            component: service,
            action: "restart",
            summary: `Repair only the managed ${service} service.`,
            external: false,
          },
        ],
        current,
      };
    },
    async applyRepair(service) {
      return repairService(
        service as "argus" | "postgres" | "searxng",
        await doctorContext(),
      );
    },
    async verifyRepair(_service, applied) {
      const report = applied as DiagnosticReport | undefined;
      if (!report?.healthy) {
        throw new DeploymentError(
          "REPAIR_VERIFY_FAILED",
          "The targeted repair could not be verified as healthy.",
          { recovery: "Run 'argus doctor' and inspect the listed safe logs." },
        );
      }
      return report;
    },
    async inspectUpdate() {
      if (updateIntegration === undefined) {
        throw new DeploymentError(
          "RELEASE_MANIFEST_REQUIRED",
          "A verified release manifest is required before Argus can plan an update.",
          { recovery: "Install Argus through the signed release channel, then retry the update." },
        );
      }
      const [release, currentReleaseInspection] = await Promise.all([
        updateIntegration.fetchUpdateRelease(),
        updateIntegration.inspectCurrentRelease(),
      ]);
      return {
        ...(await planUpdate({
          root,
          release,
          rollbackRelease: currentReleaseInspection.release,
          executor,
        })),
        currentReleaseInspection,
      };
    },
    async applyUpdate(inspection) {
      if (updateIntegration === undefined) {
        throw new DeploymentError(
          "RELEASE_MANIFEST_REQUIRED",
          "A verified release manifest is required before Argus can apply an update.",
        );
      }
      const plan = inspection as UpdatePlan & { currentReleaseInspection?: unknown };
      const currentReleaseInspection = updateIntegration.validateCurrentReleaseInspection(
        plan.currentReleaseInspection,
        plan.rollbackRelease,
      );
      if (!plan.noop && currentReleaseInspection.recovery !== "none") {
        const recoveryPlan = await planUpdate({
          root,
          release: currentReleaseInspection.release,
          rollbackRelease: currentReleaseInspection.release,
          executor,
        });
        const recovered = await applyUpdate({ root, plan: recoveryPlan, executor });
        await updateIntegration.reconcileCurrentRelease(currentReleaseInspection);
        await updateIntegration.promoteManagementRelease(currentReleaseInspection.release);
        await finalizeUpdate({ root, plan: recoveryPlan, applied: recovered });
      }
      if (!plan.noop) {
        await updateIntegration.stageCurrentRelease(plan.release);
      }
      const applied = await applyUpdate({
        root,
        plan,
        executor,
        getRollbackContext: () =>
          updateIntegration.getRollbackContext(plan.rollbackRelease),
      });
      if (!applied.health.healthy) {
        throw new DeploymentError(
          "UPDATE_HEALTHCHECK_FAILED",
          "Argus update health verification failed.",
          { recovery: "Run 'argus doctor --json' before retrying the update." },
        );
      }
      if (plan.noop) {
        await updateIntegration.reconcileCurrentRelease(currentReleaseInspection);
      } else {
        await updateIntegration.promoteCurrentRelease(plan.release);
      }
      await updateIntegration.promoteManagementRelease(
        plan.noop ? currentReleaseInspection.release : plan.release,
      );
      return finalizeUpdate({ root, plan, applied });
    },
    async verifyUpdate(applied) {
      const result = applied as { health?: { healthy?: unknown } } | undefined;
      if (result?.health?.healthy !== true) {
        throw new DeploymentError(
          "UPDATE_VERIFY_FAILED",
          "Argus update did not return a final health report.",
          { recovery: "Run 'argus doctor --json' before retrying the update." },
        );
      }
      return result.health;
    },
    async inspectRollbackUpdate() {
      if (updateIntegration === undefined) {
        throw new DeploymentError("RELEASE_MANIFEST_REQUIRED", "A verified signed rollback release is required.");
      }
      return { snapshot: await updateIntegration.fetchRollbackSnapshot() };
    },
    async applyRollbackUpdate(inspection) {
      if (updateIntegration === undefined) {
        throw new DeploymentError("RELEASE_MANIFEST_REQUIRED", "A verified signed rollback release is required.");
      }
      const rollback = inspection as { snapshot?: unknown };
      const snapshot = updateIntegration.validateRollbackSnapshot(
        rollback.snapshot,
      );
      const release = snapshot.release;
      const applied = await rollbackUpdate({ root, executor, release });
      if (!applied.health.healthy) {
        throw new DeploymentError(
          "UPDATE_ROLLBACK_VERIFY_FAILED",
          "Argus rollback health verification failed.",
          { recovery: "Run 'argus doctor --json' and preserve the existing backup for recovery." },
        );
      }
      await updateIntegration.promoteRollbackSnapshot(snapshot);
      await updateIntegration.promoteManagementRelease(release);
      return applied;
    },
    async inspectOnboarding(answers, secrets) {
      const state = await loadDeploymentState(root);
      const preflight = await inspectHost(executor, {
        apiPort: answers.deployment.apiPort,
        ...(state?.compose?.apiPort === answers.deployment.apiPort
          ? { managedComposeProject: state.composeProject }
          : {}),
        searxngEnabled: answers.managed.searxng === "managed",
        ...(process.env.ARGUS_HOST_ARCH === undefined
          ? {}
          : { hostArchitecture: process.env.ARGUS_HOST_ARCH }),
        hostPaths: MANAGEMENT_HOST_PATHS,
      });
      if (preflight.failures.length > 0) {
        throw new DeploymentError(
          "PREFLIGHT_FAILED",
          "The VPS did not pass Argus preflight checks.",
          {
            recovery:
              "Resolve the reported host prerequisites and run 'argus onboard' again.",
          },
        );
      }
      if (onboardingIntegration !== undefined) {
        return onboardingIntegration.inspect({
          answers,
          secrets,
        });
      }
      throw new DeploymentError(
        "RELEASE_MANIFEST_REQUIRED",
        "A verified release manifest is required before onboarding can plan mutations.",
        {
          recovery:
            "Install Argus through the signed release installer, then retry onboarding.",
        },
      );
    },
    async applyOnboarding(answers, secrets, inspection) {
      if (onboardingIntegration !== undefined) {
        const inspected = inspection as ReleaseOnboardingInspection;
        const application = await onboardingIntegration.apply({
          answers,
          secrets,
          inspection: inspected,
        });
        if (
          application.stateWritten !== true ||
          !sameRelease(application.release, inspected.release)
        ) {
          throw new DeploymentError(
            "ONBOARDING_APPLICATION_MISMATCH",
            "The applied release does not match the exact inspected release selection.",
          );
        }
        return application;
      }
      throw new DeploymentError(
        "RELEASE_MANIFEST_REQUIRED",
        "A verified release manifest is required before onboarding can mutate the instance.",
      );
    },
    async verifyOnboarding(answers, applied) {
      if (onboardingIntegration !== undefined) {
        const application = applied as ReleaseOnboardingApplication;
        const verified = await onboardingIntegration.verify({
          answers,
          application,
        });
        if (
          verified.healthy !== true ||
          !sameRelease(verified.release, application.release)
        ) {
          throw new DeploymentError(
            "ONBOARDING_VERIFY_FAILED",
            "The applied release could not be verified as the same healthy release.",
          );
        }
        return verified;
      }
      return getDeploymentStatus(context);
    },
  };
};

export const createNodeCliDependencies = ({
  root,
  executor,
  prompt,
  io,
  onboardingIntegration,
  installedConfigIntegration,
  updateIntegration,
  version,
}: NodeCliDependenciesOptions): CliDependencies => ({
  root,
  version: version ?? resolveCliBuildVersion(),
  prompt,
  io,
  deployment: createDeploymentAdapter(root, executor, onboardingIntegration, updateIntegration),
  files: {
    readText: (path) => readFile(path, "utf8"),
    stat: async (path) => ({ mode: (await stat(path)).mode }),
    writeSecret: (name, value) => atomicSecretWrite(root, name, value),
  },
  interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
  secretValues: async () => {
    const fileSecrets = await readSecretsFile(root);
    try {
      const referenced = await referencedEnvironment(
        installedConfigPath(root),
        { ...process.env, ...fileSecrets },
      );
      return { ...fileSecrets, ...referenced };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fileSecrets;
      throw error;
    }
  },
  config: {
    async validate(path) {
      const { config: loaded } = await loadInstalledConfig(root, path);
      return {
        valid: true,
        version: loaded.version,
        watches: loaded.watches.length,
        role: loaded.runtime.role,
      };
    },
    async inspectApply(path) {
      const loaded = await loadInstalledConfig(root, path);
      if (installedConfigIntegration === undefined) {
        throw new DeploymentError(
          "INSTALLED_CONFIG_INTEGRATION_REQUIRED",
          "Installed configuration apply requires the Argus service integration.",
          {
            recovery:
              "Wire InstalledConfigIntegration in the release composition root, then retry.",
          },
        );
      }
      return installedConfigIntegration.inspect({
        path: loaded.path,
        config: loaded.config,
      });
    },
    async apply(path, inspection) {
      const loaded = await loadInstalledConfig(root, path);
      if (installedConfigIntegration === undefined) {
        throw new DeploymentError(
          "INSTALLED_CONFIG_INTEGRATION_REQUIRED",
          "Installed configuration apply requires the Argus service integration.",
        );
      }
      const plan = inspection as InstalledConfigPlan;
      const application = await installedConfigIntegration.apply({
        path: loaded.path,
        config: loaded.config,
        inspection: plan,
      });
      if (application.planId !== plan.planId) {
        throw new DeploymentError(
          "CONFIG_APPLY_PLAN_MISMATCH",
          "The installed configuration application does not match the inspected plan.",
        );
      }
      return application;
    },
    async verifyApply(path, inspection, application) {
      const loaded = await loadInstalledConfig(root, path);
      if (installedConfigIntegration === undefined) {
        throw new DeploymentError(
          "INSTALLED_CONFIG_INTEGRATION_REQUIRED",
          "Installed configuration apply requires the Argus service integration.",
        );
      }
      const verified = await installedConfigIntegration.verify({
        path: loaded.path,
        inspection: inspection as InstalledConfigPlan,
        application: application as InstalledConfigApplication,
      });
      const plan = inspection as InstalledConfigPlan;
      if (!verified.healthy || verified.planId !== plan.planId) {
        throw new DeploymentError(
          "CONFIG_APPLY_VERIFY_FAILED",
          "The installed configuration apply could not be verified.",
        );
      }
      return verified;
    },
    async show(path) {
      const loaded = await loadInstalledConfig(root, path);
      return structurallyRedactConfig(
        loaded.config,
        Object.values(loaded.secretEnvironment),
      );
    },
  },
});
