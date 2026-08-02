import * as clack from "@clack/prompts";
import {
  DeploymentError,
  type OnboardingAnswersV1,
} from "@argus/deployment";

export interface PromptChoice {
  value: string;
  label: string;
  hint?: string;
}

export interface PromptAdapter {
  confirm(options: {
    message: string;
    initialValue?: boolean;
  }): Promise<boolean>;
  select(options: {
    message: string;
    options: PromptChoice[];
    initialValue?: string;
  }): Promise<string>;
  multiselect(options: {
    message: string;
    options: PromptChoice[];
    initialValues?: string[];
  }): Promise<string[]>;
  text(options: {
    message: string;
    initialValue?: string;
    placeholder?: string;
  }): Promise<string>;
  secret(options: { message: string }): Promise<string>;
}

const cancelled = (): never => {
  throw new DeploymentError(
    "PROMPT_CANCELLED",
    "Onboarding was cancelled.",
    { recovery: "Run 'argus onboard' to continue when ready." },
  );
};

const unwrap = <Value>(value: Value | symbol): Value =>
  clack.isCancel(value) ? cancelled() : value;

/** The only adapter allowed to depend on the terminal prompt implementation. */
export const createClackPromptAdapter = (): PromptAdapter => ({
  async confirm(options) {
    return unwrap(
      await clack.confirm({
        message: options.message,
        ...(options.initialValue === undefined
          ? {}
          : { initialValue: options.initialValue }),
      }),
    );
  },
  async select(options) {
    return unwrap(
      await clack.select({
        message: options.message,
        options: options.options,
        initialValue: options.initialValue,
      }),
    ) as string;
  },
  async multiselect(options) {
    return unwrap(
      await clack.multiselect({
        message: options.message,
        options: options.options,
        ...(options.initialValues === undefined
          ? {}
          : { initialValues: options.initialValues }),
        required: false,
      }),
    ) as string[];
  },
  async text(options) {
    return unwrap(
      await clack.text({
        message: options.message,
        ...(options.initialValue === undefined
          ? {}
          : { initialValue: options.initialValue }),
        ...(options.placeholder === undefined
          ? {}
          : { placeholder: options.placeholder }),
      }),
    );
  },
  async secret(options) {
    return unwrap(await clack.password({ message: options.message }));
  },
});

const commaSeparated = (value: string): string[] =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

const urlList = (value: string): string[] => commaSeparated(value);

export interface CollectedOnboarding {
  answers: OnboardingAnswersV1;
  secrets: Record<string, string>;
}

/**
 * Collects only relevant V1 answers. Secret values have a separate return
 * channel and are never added to the versioned answers object.
 */
export const collectOnboarding = async (
  prompt: PromptAdapter,
): Promise<CollectedOnboarding> => {
  const storage = (await prompt.select({
    message: "Storage",
    options: [
      { value: "sqlite", label: "SQLite", hint: "recommended" },
      { value: "postgres", label: "PostgreSQL" },
    ],
    initialValue: "sqlite",
  })) as "sqlite" | "postgres";
  const apiPortValue = await prompt.text({
    message: "Argus API port",
    initialValue: "8788",
  });
  const apiPort = Number(apiPortValue || "8788");
  const sources = await prompt.multiselect({
    message: "Enable data sources",
    options: [
      { value: "x", label: "X" },
      { value: "telegram", label: "Telegram announcements" },
      { value: "web", label: "Web" },
    ],
  });
  const enabled = new Set(sources);
  const watchId =
    (await prompt.text({
      message: "Watch id",
      initialValue: "default",
    })) || "default";
  const schedule =
    (await prompt.text({
      message: "Collection schedule",
      initialValue: "*/5 * * * *",
    })) || "*/5 * * * *";

  const xAccounts = enabled.has("x")
    ? commaSeparated(
        await prompt.text({ message: "X accounts (comma-separated)" }),
      )
    : [];
  const xQueries = enabled.has("x")
    ? commaSeparated(
        await prompt.text({ message: "X queries (comma-separated)" }),
      )
    : [];
  const telegramChannels = enabled.has("telegram")
    ? commaSeparated(
        await prompt.text({
          message: "Public Telegram channels (comma-separated)",
        }),
      )
    : [];
  const webUrls = enabled.has("web")
    ? urlList(
        await prompt.text({ message: "Web URLs (comma-separated)" }),
      )
    : [];
  const webFeeds = enabled.has("web")
    ? urlList(
        await prompt.text({ message: "Web feeds (comma-separated)" }),
      )
    : [];
  const webQueries = enabled.has("web")
    ? commaSeparated(
        await prompt.text({
          message: "Web search queries (comma-separated)",
        }),
      )
    : [];

  let searxng: OnboardingAnswersV1["managed"]["searxng"] = "disabled";
  let searxngEndpoint: string | undefined;
  if (webQueries.length > 0) {
    searxng = (await prompt.select({
      message: "SearXNG",
      options: [
        { value: "managed", label: "Managed", hint: "recommended" },
        { value: "external", label: "External endpoint" },
      ],
      initialValue: "managed",
    })) as "managed" | "external";
    if (searxng === "external") {
      searxngEndpoint = await prompt.text({
        message: "External SearXNG endpoint",
      });
    }
  }

  let fxembed: OnboardingAnswersV1["managed"]["fxembed"] = "disabled";
  let fxembedEndpoint: string | undefined;
  let cloudflareAccountId: string | undefined;
  if (enabled.has("x")) {
    fxembed = (await prompt.select({
      message: "FxEmbed",
      options: [
        { value: "managed", label: "Managed on Cloudflare", hint: "recommended" },
        { value: "external", label: "External endpoint" },
      ],
      initialValue: "managed",
    })) as "managed" | "external";
    if (fxembed === "managed") {
      cloudflareAccountId = await prompt.text({
        message: "Cloudflare account id",
      });
    } else {
      fxembedEndpoint = await prompt.text({
        message: "External FxEmbed endpoint",
      });
    }
  }

  const intelligenceEnabled = await prompt.confirm({
    message: "Enable OpenRouter summaries?",
    initialValue: false,
  });
  const intelligenceModel = intelligenceEnabled
    ? (await prompt.text({
        message: "OpenRouter model",
        initialValue: "openai/gpt-4.1-mini",
      })) || "openai/gpt-4.1-mini"
    : "openai/gpt-4.1-mini";
  const keywords = commaSeparated(
    await prompt.text({ message: "Keywords (comma-separated)" }),
  );

  const secrets: Record<string, string> = {
    ARGUS_API_TOKEN: await prompt.secret({ message: "Argus API token" }),
  };
  if (storage === "postgres") {
    secrets.POSTGRES_PASSWORD = await prompt.secret({
      message: "PostgreSQL password",
    });
  }
  if (fxembed === "managed") {
    secrets.CLOUDFLARE_API_TOKEN = await prompt.secret({
      message: "Cloudflare API token",
    });
  }
  if (intelligenceEnabled) {
    secrets.OPENROUTER_API_KEY = await prompt.secret({
      message: "OpenRouter API key",
    });
  }

  return {
    answers: {
      version: 1,
      deployment: {
        provider: "vps-docker",
        root: "/opt/argus",
        storage,
        apiHost: "0.0.0.0",
        apiPort,
      },
      managed: { searxng, fxembed },
      ...(cloudflareAccountId
        ? { cloudflare: { accountId: cloudflareAccountId } }
        : {}),
      ...(searxngEndpoint || fxembedEndpoint
        ? {
            external: {
              ...(searxngEndpoint ? { searxngEndpoint } : {}),
              ...(fxembedEndpoint ? { fxembedEndpoint } : {}),
            },
          }
        : {}),
      watches: [
        {
          id: watchId,
          enabled: true,
          schedule,
          x: { accounts: xAccounts, queries: xQueries },
          telegram: { channels: telegramChannels },
          web: { urls: webUrls, feeds: webFeeds, queries: webQueries },
          keywords,
        },
      ],
      intelligence: {
        enabled: intelligenceEnabled,
        model: intelligenceModel,
      },
    },
    secrets,
  };
};

export const collectRequiredSecrets = async (
  answers: OnboardingAnswersV1,
  prompt: PromptAdapter,
): Promise<Record<string, string>> => {
  const secrets: Record<string, string> = {
    ARGUS_API_TOKEN: await prompt.secret({ message: "Argus API token" }),
  };
  if (answers.deployment.storage === "postgres") {
    secrets.POSTGRES_PASSWORD = await prompt.secret({
      message: "PostgreSQL password",
    });
  }
  if (answers.managed.fxembed === "managed") {
    secrets.CLOUDFLARE_API_TOKEN = await prompt.secret({
      message: "Cloudflare API token",
    });
  }
  if (answers.intelligence.enabled) {
    secrets.OPENROUTER_API_KEY = await prompt.secret({
      message: "OpenRouter API key",
    });
  }
  return secrets;
};
