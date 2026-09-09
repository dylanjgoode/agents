import { z } from "zod";

export type RuntimeMode = "socket" | "http";

export interface SlackBotConfig {
  mode: RuntimeMode;
  slack: {
    botToken: string;
    appToken?: string;
    signingSecret?: string;
    botDisplayName: string;
    allowedUserIds: string[];
  };
  agentic: {
    baseUrl: string;
    apiKey?: string;
    projectId: string;
    workspaceId: string;
    invokeTarget: "gateway" | "local";
  };
  store: {
    mongoUri?: string;
    databaseName: string;
  };
}

const requiredString = z.string().trim().min(1, "is required");
const emptyStringToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;
const optionalString = z.preprocess(
  emptyStringToUndefined,
  z.string().trim().min(1).optional(),
);
const optionalUrl = z.preprocess(
  emptyStringToUndefined,
  z.url().optional(),
);

const environmentSchema = z
  .object({
    SLACK_BOT_TOKEN: requiredString,
    AGENTIC_API_KEY: optionalString,
    AGENTIC_PROJECT_ID: optionalString,
    AGENTIC_WORKSPACE_ID: optionalString,
    AGENTIC_INVOKE_TARGET: z
      .enum(["gateway", "local"])
      .optional()
      .default("gateway"),
    SLACK_SIGNING_SECRET: optionalString,
    MONGODB_URI: optionalString,
    SLACK_APP_TOKEN: optionalString,
    SLACK_BOT_DISPLAY_NAME: optionalString,
    SLACK_ALLOWED_USER_IDS: optionalString,
    AGENTIC_BASE_URL: optionalUrl,
    THREAD_STORE_DB: optionalString,
  })
  .passthrough();

function formatEnvironmentError(error: z.ZodError): string {
  const issues = error.issues.map((issue) => {
    const variable = String(issue.path[0] ?? "environment");
    return `${variable} ${issue.message}`;
  });
  return `Invalid environment: ${issues.join("; ")}`;
}

export function loadConfig(
  environment: Record<string, string | undefined>,
  mode: RuntimeMode,
): SlackBotConfig {
  const result = environmentSchema.safeParse(environment);
  const issues = result.success ? [] : [...result.error.issues];
  const parsed = result.success ? result.data : environment;

  if (mode === "socket" && !parsed.SLACK_APP_TOKEN?.trim()) {
    issues.push({
      code: "custom",
      message: "is required in Socket Mode",
      path: ["SLACK_APP_TOKEN"],
    });
  }
  if (mode === "http" && !parsed.SLACK_SIGNING_SECRET?.trim()) {
    issues.push({
      code: "custom",
      message: "is required in HTTP mode",
      path: ["SLACK_SIGNING_SECRET"],
    });
  }
  if (mode === "http" && !parsed.MONGODB_URI?.trim()) {
    issues.push({
      code: "custom",
      message: "is required in HTTP mode",
      path: ["MONGODB_URI"],
    });
  }
  if (
    !parsed.SLACK_ALLOWED_USER_IDS?.split(",").some(
      (userId) => userId.trim().length > 0,
    )
  ) {
    issues.push({
      code: "custom",
      message: "is required",
      path: ["SLACK_ALLOWED_USER_IDS"],
    });
  }
  const invokeTarget =
    parsed.AGENTIC_INVOKE_TARGET?.trim() === "local"
      ? "local"
      : "gateway";
  if (invokeTarget === "gateway") {
    for (const variable of [
      "AGENTIC_API_KEY",
      "AGENTIC_PROJECT_ID",
      "AGENTIC_WORKSPACE_ID",
    ] as const) {
      if (!parsed[variable]?.trim()) {
        issues.push({
          code: "custom",
          message: "is required for the gateway target",
          path: [variable],
        });
      }
    }
  }
  if (issues.length > 0) {
    throw new Error(formatEnvironmentError(new z.ZodError(issues)));
  }
  if (!result.success) {
    throw new Error(formatEnvironmentError(result.error));
  }

  const values = result.data;
  const allowedUserIds = values.SLACK_ALLOWED_USER_IDS
    ? [...new Set(
        values.SLACK_ALLOWED_USER_IDS.split(",")
          .map((userId) => userId.trim())
          .filter(Boolean),
      )]
    : [];
  return {
    mode,
    slack: {
      botToken: values.SLACK_BOT_TOKEN,
      ...(values.SLACK_APP_TOKEN
        ? { appToken: values.SLACK_APP_TOKEN }
        : {}),
      ...(values.SLACK_SIGNING_SECRET
        ? { signingSecret: values.SLACK_SIGNING_SECRET }
        : {}),
      allowedUserIds,
      botDisplayName: values.SLACK_BOT_DISPLAY_NAME ?? "AtlasExplorer",
    },
    agentic: {
      baseUrl: (
        values.AGENTIC_BASE_URL ??
        (values.AGENTIC_INVOKE_TARGET === "local"
          ? "http://localhost:3000"
          : "https://agentic-platform.mongodb.com")
      ).replace(/\/+$/, ""),
      ...(values.AGENTIC_API_KEY
        ? { apiKey: values.AGENTIC_API_KEY }
        : {}),
      projectId: values.AGENTIC_PROJECT_ID ?? "local",
      workspaceId: values.AGENTIC_WORKSPACE_ID ?? "local",
      invokeTarget: values.AGENTIC_INVOKE_TARGET,
    },
    store: {
      ...(values.MONGODB_URI ? { mongoUri: values.MONGODB_URI } : {}),
      databaseName: values.THREAD_STORE_DB ?? "atlas_explorer_slack",
    },
  };
}
