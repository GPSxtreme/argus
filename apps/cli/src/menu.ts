import { DeploymentError } from "@argus/deployment";
import type { PromptAdapter } from "./prompts.js";

export type MenuInvocation = readonly string[] | null;

const selectLogsInvocation = async (
  prompt: PromptAdapter,
): Promise<readonly string[]> => {
  const service = await prompt.select({
    message: "Which logs?",
    options: [
      { value: "argus", label: "Argus" },
      { value: "all", label: "All services" },
      { value: "postgres", label: "PostgreSQL" },
      { value: "searxng", label: "SearXNG" },
    ],
    initialValue: "argus",
  });
  const tailValue =
    (await prompt.text({ message: "How many lines?", initialValue: "200" })) ||
    "200";
  if (!/^[1-9]\d*$/u.test(tailValue)) {
    throw new DeploymentError(
      "LOG_TAIL_INVALID",
      "Log tail must be a positive integer no greater than 10000.",
      { recovery: "Run 'argus logs --tail 200'." },
    );
  }
  const tail = Number(tailValue);
  if (!Number.isSafeInteger(tail) || tail > 10_000) {
    throw new DeploymentError(
      "LOG_TAIL_INVALID",
      "Log tail must be a positive integer no greater than 10000.",
      { recovery: "Run 'argus logs --tail 200'." },
    );
  }
  return [
    "logs",
    ...(service === "all" ? [] : [service]),
    "--tail",
    tailValue,
  ];
};

const selectConfigInvocation = async (
  prompt: PromptAdapter,
): Promise<readonly string[]> => [
  "config",
  await prompt.select({
    message: "Manage configuration",
    options: [
      { value: "show", label: "Show active configuration" },
      { value: "validate", label: "Validate configuration" },
      { value: "apply", label: "Apply configuration" },
      { value: "schema", label: "Show configuration schema" },
    ],
    initialValue: "show",
  }),
];

const selectServiceInvocation = async (
  prompt: PromptAdapter,
): Promise<readonly string[]> => [
  await prompt.select({
    message: "Manage Argus services",
    options: [
      { value: "status", label: "Check status" },
      { value: "start", label: "Start services" },
      { value: "stop", label: "Stop services" },
      { value: "restart", label: "Restart services" },
    ],
    initialValue: "status",
  }),
];

const selectSecretInvocation = async (
  prompt: PromptAdapter,
): Promise<readonly string[]> => [
  "secrets",
  "set",
  await prompt.text({
    message: "Secret name",
    placeholder: "ARGUS_API_TOKEN",
  }),
];

export const selectMenuInvocation = async (
  prompt: PromptAdapter,
): Promise<MenuInvocation> => {
  const selection = await prompt.select({
    message: "What do you want to do?",
    options: [
      { value: "onboard", label: "Set up Argus", hint: "first-time setup" },
      { value: "status", label: "Check status" },
      { value: "query", label: "Ask Argus" },
      { value: "logs", label: "View logs" },
      { value: "config", label: "Manage configuration" },
      { value: "doctor", label: "Run diagnostics" },
      { value: "update", label: "Update Argus" },
      { value: "services", label: "Start, stop, or restart services" },
      { value: "secrets", label: "Manage secrets" },
      { value: "exit", label: "Exit" },
    ],
    initialValue: "status",
  });

  switch (selection) {
    case "onboard":
    case "status":
    case "doctor":
    case "update":
      return [selection];
    case "query":
      return [
        "query",
        await prompt.text({ message: "What do you want to know?" }),
      ];
    case "logs":
      return selectLogsInvocation(prompt);
    case "config":
      return selectConfigInvocation(prompt);
    case "services":
      return selectServiceInvocation(prompt);
    case "secrets":
      return selectSecretInvocation(prompt);
    case "exit":
      return null;
    default:
      throw new TypeError(`Unknown menu action: ${selection}`);
  }
};
