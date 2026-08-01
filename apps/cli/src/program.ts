import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { openRepository, startRuntime } from "@argus/app";
import {
  loadConfig,
  reconcileConfig,
  resolveConfigPath,
} from "@argus/config";
import {
  createArgusDoctorApi,
  DeploymentError,
  getDeploymentStatus,
  inspectHost,
  loadDeploymentState,
  onboardingAnswersSchema,
  repairService,
  restartDeployment,
  runDoctor,
  startDeployment,
  stopDeployment,
  type DiagnosticReport,
  type OnboardingAnswersV1,
  type CommandExecutor,
} from "@argus/deployment";
import { targetsFromConfig } from "@argus/scheduler";
import { Command } from "commander";
import { parse } from "yaml";
import { z } from "zod";
import {
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
  inspectOnboarding(
    answers: OnboardingAnswersV1,
    secrets: Readonly<Record<string, string>>,
  ): Promise<unknown>;
  applyOnboarding(
    answers: OnboardingAnswersV1,
    secrets: Readonly<Record<string, string>>,
  ): Promise<unknown>;
  verifyOnboarding(
    answers: OnboardingAnswersV1,
    applied?: unknown,
  ): Promise<unknown>;
}

export interface CliFiles {
  readText(path: string): Promise<string>;
  stat(path: string): Promise<{ mode: number }>;
  writeSecret(name: string, value: string): Promise<void>;
}

export interface ConfigCliAdapter {
  validate(path?: string): Promise<unknown>;
  apply(path?: string): Promise<unknown>;
  show(path?: string): Promise<unknown>;
  run?(path?: string): Promise<void>;
}

export interface CliDependencies {
  deployment: DeploymentCliAdapter;
  prompt: PromptAdapter;
  io: CliIO;
  files: CliFiles;
  config: ConfigCliAdapter;
  root: string;
  secretValues(): Promise<Record<string, string>>;
}

interface CommonOptions {
  json?: boolean;
}

interface MutationOptions extends CommonOptions {
  yes?: boolean;
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
    { recovery: "Review the plan, then rerun with --yes." },
  );

const confirmMutation = async (
  prompt: PromptAdapter,
  options: MutationOptions,
  message: string,
): Promise<void> => {
  if (options.yes) return;
  if (options.json) throw confirmationRequired();
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
): Promise<void> => {
  try {
    const result = await operation();
    const secrets = await secretList(dependencies);
    writeSuccess(
      dependencies.io,
      options.json === true,
      redactValue(result.data, secrets),
      replaceSecrets(result.human, secrets),
    );
  } catch (error) {
    const secrets = await secretList(dependencies).catch(() => []);
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
  );

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
      await confirmMutation(
        dependencies.prompt,
        options,
        `${action} Argus using the inspected plan?`,
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

  commonOptions(
    config
      .command("schema")
      .description("Print the versioned onboarding answers JSON Schema"),
  ).action(async (options: CommonOptions) => {
    await execute(dependencies, options, async () => ({
      data: z.toJSONSchema(onboardingAnswersSchema),
      human: JSON.stringify(z.toJSONSchema(onboardingAnswersSchema), null, 2),
    }));
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
        const inspected = await dependencies.config.validate(path);
        await confirmMutation(
          dependencies.prompt,
          options,
          "Apply the validated configuration?",
        );
        const applied = await dependencies.config.apply(path);
        return {
          data: { plan: inspected, result: applied },
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
        human: JSON.stringify(shown, null, 2),
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
  mutationOptions(
    secrets
      .command("set")
      .argument("<name>", "environment-style secret name")
      .description("Set one secret using a hidden prompt"),
  ).action(async (name: string, options: MutationOptions) => {
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
      await confirmMutation(
        dependencies.prompt,
        options,
        `${exists ? "Update" : "Create"} ${name} in the owner-only instance secrets file?`,
      );
      const value = await dependencies.prompt.secret({
        message: `Value for ${name}`,
      });
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
            name,
            action: exists ? "update" : "create",
          },
          result: { name, updated: true },
        },
        human: `${name} was stored securely.`,
      };
    });
  });
};

export const createProgram = (dependencies: CliDependencies): Command => {
  const program = new Command()
    .name("argus")
    .description("Self-hosted data layer for X, Telegram, and the Web")
    .version("0.1.0")
    .showHelpAfterError();

  mutationOptions(
    program
      .command("onboard")
      .description("Interactively configure and reconcile an Argus VPS")
      .option("--from <path>", "read strict non-secret YAML answers"),
  ).action(
    async (
      options: MutationOptions & { from?: string },
    ): Promise<void> => {
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
        const secrets =
          collected.secrets ??
          (await collectRequiredSecrets(answers, dependencies.prompt));
        const plan = await dependencies.deployment.inspectOnboarding(
          answers,
          secrets,
        );
        await confirmMutation(
          dependencies.prompt,
          options,
          "Apply and verify this Argus VPS plan?",
        );
        const applied = await dependencies.deployment.applyOnboarding(
          answers,
          secrets,
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
      });
    },
  );

  lifecycleCommand(program, dependencies, "start");
  lifecycleCommand(program, dependencies, "stop");
  lifecycleCommand(program, dependencies, "restart");

  commonOptions(
    program.command("status").description("Inspect Argus service status"),
  ).action(async (options: CommonOptions) => {
    await execute(dependencies, options, async () => ({
      data: await dependencies.deployment.status(),
      human: "Argus status inspected.",
    }));
  });

  commonOptions(
    program
      .command("logs")
      .argument("[service]", "argus, postgres, or searxng")
      .option("--tail <lines>", "maximum log lines", "200")
      .description("Read bounded service logs"),
  ).action(
    async (
      service: string | undefined,
      options: CommonOptions & { tail: string },
    ) => {
      await execute(dependencies, options, async () => {
        const parsed = Number.parseInt(options.tail, 10);
        const tail = Number.isFinite(parsed)
          ? Math.min(Math.max(parsed, 1), 10_000)
          : 200;
        const logs = await dependencies.deployment.logs(service, {
          tail,
          timeoutMs: 30_000,
        });
        return { data: { service: service ?? "all", logs }, human: logs };
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
        human: report.healthy
          ? "Argus diagnostics are healthy."
          : "Argus diagnostics found unhealthy components.",
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
      await confirmMutation(
        dependencies.prompt,
        options,
        `Apply the targeted ${service} repair?`,
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

  registerConfig(program, dependencies);
  registerSecrets(program, dependencies);
  program
    .command("run")
    .argument("[path]", "configuration path")
    .description("Start the configured Argus runtime role")
    .action(async (path?: string) => {
      if (dependencies.config.run === undefined) {
        throw new DeploymentError(
          "RUNTIME_UNAVAILABLE",
          "The direct development runtime is unavailable.",
        );
      }
      await dependencies.config.run(path);
    });
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
  try {
    return parseSecrets(await readFile(join(root, "secrets.env"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
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
    .sort(([left], [right]) => left.localeCompare(right))
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

export interface NodeCliDependenciesOptions {
  root: string;
  executor: CommandExecutor;
  prompt: PromptAdapter;
  io: CliIO;
}

const createDeploymentAdapter = (
  root: string,
  executor: CommandExecutor,
): DeploymentCliAdapter => {
  const context = { root, executor };
  const doctorContext = async () => {
    const secrets = await readSecretsFile(root);
    const config = await loadConfig(join(root, "argus.yaml"), {
      ...process.env,
      ...secrets,
    });
    const state = await loadDeploymentState(root);
    const targets = targetsFromConfig(config);
    const diagnosticTargetIds = Object.fromEntries(
      (["x", "telegram", "web"] as const).flatMap((source) => {
        const selected = targets.find((target) => target.source === source);
        return selected === undefined ? [] : [[source, selected.id]];
      }),
    );
    const searxngEndpoint = config.sources.web.searchEndpoint;
    const fxembedEndpoint = config.sources.x.endpoint;
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
      ...(fxembedEndpoint === undefined ? {} : { fxembedEndpoint }),
    };
  };
  const lifecycle = {
    start: startDeployment,
    stop: stopDeployment,
    restart: restartDeployment,
  } as const;
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
      return {
        state: status.healthy ? "running" : "degraded",
        services: Object.fromEntries(
          status.services.map((service) => [
            service.name,
            service.health ?? service.state,
          ]),
        ),
      };
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
    async inspectOnboarding(answers) {
      const preflight = await inspectHost(executor, {
        apiPort: answers.deployment.apiPort,
        searxngEnabled: answers.managed.searxng === "managed",
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
      throw new DeploymentError(
        "RELEASE_MANIFEST_REQUIRED",
        "A verified release manifest is required before onboarding can plan mutations.",
        {
          recovery:
            "Install Argus through the signed release installer, then retry onboarding.",
        },
      );
    },
    async applyOnboarding() {
      throw new DeploymentError(
        "RELEASE_MANIFEST_REQUIRED",
        "A verified release manifest is required before onboarding can mutate the instance.",
      );
    },
    async verifyOnboarding() {
      return getDeploymentStatus(context);
    },
  };
};

export const createNodeCliDependencies = ({
  root,
  executor,
  prompt,
  io,
}: NodeCliDependenciesOptions): CliDependencies => ({
  root,
  prompt,
  io,
  deployment: createDeploymentAdapter(root, executor),
  files: {
    readText: (path) => readFile(path, "utf8"),
    stat: async (path) => ({ mode: (await stat(path)).mode }),
    writeSecret: (name, value) => atomicSecretWrite(root, name, value),
  },
  secretValues: () => readSecretsFile(root),
  config: {
    async validate(path) {
      const loaded = await loadConfig(
        resolveConfigPath(path ? { explicitPath: path } : {}),
      );
      return {
        valid: true,
        version: loaded.version,
        watches: loaded.watches.length,
        role: loaded.runtime.role,
      };
    },
    async apply(path) {
      const loaded = await loadConfig(
        resolveConfigPath(path ? { explicitPath: path } : {}),
      );
      const handle = await openRepository(loaded);
      try {
        return {
          applied: true,
          ...(await reconcileConfig(handle.repository, loaded)),
        };
      } finally {
        await handle.close();
      }
    },
    async show(path) {
      const secrets = await readSecretsFile(root);
      return loadConfig(
        resolveConfigPath(
          path
            ? { explicitPath: path }
            : { explicitPath: join(root, "argus.yaml") },
        ),
        { ...process.env, ...secrets },
      );
    },
    async run(path) {
      await startRuntime(resolveConfigPath(path ? { explicitPath: path } : {}));
    },
  },
});
