import {
  DeploymentError,
  type OnboardingAnswers,
} from "@argus/deployment";
import * as clack from "@clack/prompts";

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

const runClackPrompt = async <Value>(
  start: (signal: AbortSignal) => Promise<Value | symbol>,
): Promise<Value> => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const abortOnEof = (chunk: Buffer | string) => {
    if (Buffer.from(chunk).includes(4)) abort();
  };
  process.stdin.on("data", abortOnEof);
  process.stdin.once("end", abort);
  try {
    return unwrap(await start(controller.signal));
  } catch (error) {
    if (controller.signal.aborted) return cancelled();
    throw error;
  } finally {
    process.stdin.off("data", abortOnEof);
    process.stdin.off("end", abort);
  }
};

/** The only adapter allowed to depend on the terminal prompt implementation. */
export const createClackPromptAdapter = (): PromptAdapter => ({
  async confirm(options) {
    return runClackPrompt((signal) =>
      clack.confirm({
        message: options.message,
        signal,
        ...(options.initialValue === undefined
          ? {}
          : { initialValue: options.initialValue }),
      }),
    );
  },
  async select(options) {
    return (await runClackPrompt((signal) =>
      clack.select({
        message: options.message,
        options: options.options,
        initialValue: options.initialValue,
        signal,
      }),
    )) as string;
  },
  async multiselect(options) {
    return (await runClackPrompt((signal) =>
      clack.multiselect({
        message: options.message,
        options: options.options,
        signal,
        ...(options.initialValues === undefined
          ? {}
          : { initialValues: options.initialValues }),
        required: false,
      }),
    )) as string[];
  },
  async text(options) {
    return runClackPrompt((signal) =>
      clack.text({
        message: options.message,
        signal,
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
    return runClackPrompt((signal) =>
      clack.password({ message: options.message, signal }),
    );
  },
});

const commaSeparated = (value: string): string[] =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

const urlList = (value: string): string[] => commaSeparated(value);

export interface CollectedOnboarding {
  answers: OnboardingAnswers;
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

  let searxng: OnboardingAnswers["managed"]["searxng"] = "disabled";
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

  let fxembed: OnboardingAnswers["managed"]["fxembed"] = "disabled";
  let fxembedEndpoint: string | undefined;
  let cloudflareAccountId: string | undefined;
  if (enabled.has("x")) {
    fxembed = (await prompt.select({
      message: "FxEmbed",
      options: [
        { value: "vps", label: "Run on this VPS", hint: "recommended" },
        { value: "cloudflare", label: "Deploy to Cloudflare" },
        { value: "external", label: "External endpoint" },
        { value: "disabled", label: "Disable X" },
      ],
      initialValue: "vps",
    })) as OnboardingAnswers["managed"]["fxembed"];
    if (fxembed === "cloudflare") {
      cloudflareAccountId = await prompt.text({
        message: "Cloudflare account id",
      });
    } else if (fxembed === "external") {
      fxembedEndpoint = await prompt.text({
        message: "External FxEmbed endpoint",
      });
    }
  }

  const xRepliesEnabled = enabled.has("x")
    ? await prompt.confirm({
        message: "Track replies to X posts?",
        initialValue: true,
      })
    : false;
  let xReplyProfile = "standard";
  if (xRepliesEnabled) {
    xReplyProfile = await prompt.select({
      message: "X reply tracking profile",
      options: [
        { value: "standard", label: "Standard · 7 days", hint: "recommended" },
        { value: "hot", label: "Hot · 24 hours" },
        { value: "niche", label: "Niche · 30 days" },
        { value: "custom", label: "Custom" },
      ],
      initialValue: "standard",
    });
  }
  const profileHours = { hot: 24, standard: 168, niche: 720 } as const;
  const maxTrackingHours =
    xReplyProfile === "custom"
      ? Number(
          (await prompt.text({
            message: "Track replies for how many hours?",
            initialValue: "168",
          })) || "168",
        )
      : profileHours[xReplyProfile as keyof typeof profileHours] ?? 168;
  const maxPerPost =
    xReplyProfile === "custom"
      ? Number(
          (await prompt.text({
            message: "Maximum observed replies per post",
            initialValue: "50",
          })) || "50",
        )
      : 50;
  const orderBy =
    xReplyProfile === "custom"
      ? ((await prompt.select({
          message: "Order observed replies by",
          options: [
            { value: "likes", label: "Likes", hint: "recommended" },
            { value: "newest", label: "Newest" },
            { value: "oldest", label: "Oldest" },
            { value: "replies", label: "Reply count" },
            { value: "reposts", label: "Reposts" },
            { value: "views", label: "Views" },
            { value: "source", label: "Source order" },
          ],
          initialValue: "likes",
        })) as OnboardingAnswers["xReplies"]["orderBy"])
      : "likes";

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
  if (fxembed === "cloudflare") {
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
      version: 2,
      deployment: {
        provider: "vps-docker",
        root: "/opt/argus",
        storage,
        apiHost: "0.0.0.0",
        apiPort,
      },
      managed: { searxng, fxembed },
      xReplies: {
        enabled: xRepliesEnabled,
        maxPerPost,
        maxTrackingHours,
        orderBy,
      },
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
  answers: OnboardingAnswers,
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
  if (answers.managed.fxembed === "cloudflare") {
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
