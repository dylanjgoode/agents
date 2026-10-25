/**
 * Copyright 2026 MongoDB, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { z } from "zod";

import type { AgentEngineClientConfig } from "@repo/agent-engine-chat/agent-engine";

/**
 * `local` serves the webhook from `src/index.ts` and may start an embedded
 * MongoDB. `http` is the Vercel function and requires `MONGODB_URI`.
 */
export type RuntimeMode = "local" | "http";

export interface WhatsAppBotConfig {
  mode: RuntimeMode;
  chat: {
    allowedActorIds: string[];
  };
  whatsapp: {
    accessToken: string;
    appSecret: string;
    phoneNumberId: string;
    verifyToken: string;
    botDisplayName: string;
    /** Graph API base URL. Unset calls https://graph.facebook.com. */
    apiUrl?: string;
  };
  agentEngine: AgentEngineClientConfig;
  /**
   * Caps how many agent sessions can be active within a rolling hour, so the
   * shared Atlas service account does not run out of MCP access tokens.
   */
  sessionLimit: {
    /** Seconds without activity after which a thread's agent sandbox is retired. */
    idleTtlSeconds: number;
    /** Most agent sessions allowed to be active within any rolling hour. */
    limitPerHour: number;
  };
  store: {
    mongoUri?: string;
    databaseName: string;
  };
}

const DEFAULT_BOT_NAME = "AtlasExplorer";
const DEFAULT_THREAD_STORE_DB = "atlas_explorer_whatsapp";
// See the Slack bot's loadConfig.ts: a session mints 2 of the service
// account's 100 MCP tokens, and the default leaves headroom below 50.
const DEFAULT_SESSION_LIMIT_PER_HOUR = 40;
// Agent Engine keeps a session's sandbox through this idle period (AP-7168).
const DEFAULT_SESSION_IDLE_TTL_SECONDS = 600;

const WHATSAPP_PREFIX = "whatsapp:";

const requiredString = z
  .string({ error: "is required" })
  .trim()
  .min(1, "is required");
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
const optionalPositiveInteger = z.preprocess(
  emptyStringToUndefined,
  z.coerce.number().int().positive().optional(),
);

const environmentSchema = z
  .object({
    WHATSAPP_ACCESS_TOKEN: requiredString,
    WHATSAPP_APP_SECRET: requiredString,
    WHATSAPP_PHONE_NUMBER_ID: requiredString,
    WHATSAPP_VERIFY_TOKEN: requiredString,
    WHATSAPP_API_URL: optionalUrl,
    WHATSAPP_BOT_DISPLAY_NAME: optionalString,
    CHAT_ALLOWED_USER_IDS: requiredString,
    AGENTIC_INVOKE_TARGET: z
      .enum(["gateway", "local"])
      .optional()
      .default("gateway"),
    AGENTIC_BASE_URL: optionalUrl,
    AGENTIC_SA_CLIENT_ID: optionalString,
    AGENTIC_SA_CLIENT_SECRET: optionalString,
    AGENTIC_PROJECT_ID: optionalString,
    AGENTIC_WORKSPACE_ID: optionalString,
    MONGODB_URI: optionalString,
    THREAD_STORE_DB: optionalString,
    SESSION_LIMIT_PER_HOUR: optionalPositiveInteger,
    SESSION_IDLE_TTL_SECONDS: optionalPositiveInteger,
  })
  .passthrough()
  .superRefine((values, context) => {
    const actorIds = values.CHAT_ALLOWED_USER_IDS.split(",")
      .map((actorId) => actorId.trim())
      .filter(Boolean);
    if (
      actorIds.length === 0 ||
      actorIds.some((actorId) => !parseWhatsAppActorId(actorId))
    ) {
      context.addIssue({
        code: "custom",
        message: "must contain WhatsApp IDs such as whatsapp:447700900123",
        path: ["CHAT_ALLOWED_USER_IDS"],
      });
    }
    if (values.AGENTIC_INVOKE_TARGET === "gateway") {
      for (const variable of [
        "AGENTIC_SA_CLIENT_ID",
        "AGENTIC_SA_CLIENT_SECRET",
        "AGENTIC_PROJECT_ID",
        "AGENTIC_WORKSPACE_ID",
      ] as const) {
        if (!values[variable]) {
          context.addIssue({
            code: "custom",
            message: "is required for the gateway target",
            path: [variable],
          });
        }
      }
    }
  });

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
): WhatsAppBotConfig {
  const result = environmentSchema.safeParse(environment);
  const issues = result.success ? [] : [...result.error.issues];
  if (mode === "http" && !environment.MONGODB_URI?.trim()) {
    issues.push({
      code: "custom",
      message: "is required in HTTP mode",
      path: ["MONGODB_URI"],
      input: environment.MONGODB_URI,
    });
  }
  if (!result.success || issues.length > 0) {
    throw new Error(formatEnvironmentError(new z.ZodError(issues)));
  }

  const values = result.data;
  const allowedActorIds = [
    ...new Set(
      values.CHAT_ALLOWED_USER_IDS.split(",")
        .map((actorId) => actorId.trim())
        .filter(Boolean)
        .map((actorId) => parseWhatsAppActorId(actorId)!),
    ),
  ];
  return {
    mode,
    chat: {
      allowedActorIds,
    },
    whatsapp: {
      accessToken: values.WHATSAPP_ACCESS_TOKEN,
      appSecret: values.WHATSAPP_APP_SECRET,
      phoneNumberId: values.WHATSAPP_PHONE_NUMBER_ID,
      verifyToken: values.WHATSAPP_VERIFY_TOKEN,
      botDisplayName: values.WHATSAPP_BOT_DISPLAY_NAME ?? DEFAULT_BOT_NAME,
      ...(values.WHATSAPP_API_URL ? { apiUrl: values.WHATSAPP_API_URL } : {}),
    },
    agentEngine: buildAgenticConfig(values),
    sessionLimit: {
      idleTtlSeconds:
        values.SESSION_IDLE_TTL_SECONDS ??
        DEFAULT_SESSION_IDLE_TTL_SECONDS,
      limitPerHour:
        values.SESSION_LIMIT_PER_HOUR ?? DEFAULT_SESSION_LIMIT_PER_HOUR,
    },
    store: {
      ...(values.MONGODB_URI ? { mongoUri: values.MONGODB_URI } : {}),
      databaseName: values.THREAD_STORE_DB ?? DEFAULT_THREAD_STORE_DB,
    },
  };
}

/**
 * Returns the actor ID the WhatsApp adapter reports for this entry, or null
 * when the entry isn't a WhatsApp ID.
 *
 * Meta sends phone numbers as digits only, so a number written as
 * `whatsapp:+44 7700 900123` is reduced to `whatsapp:447700900123`. Anything
 * else after the prefix, such as a business-scoped user ID
 * (`US.13491208655302741918`), is kept as written.
 */
export function parseWhatsAppActorId(entry: string): string | null {
  if (entry.slice(0, WHATSAPP_PREFIX.length).toLowerCase() !== WHATSAPP_PREFIX) {
    return null;
  }
  const userId = entry.slice(WHATSAPP_PREFIX.length).trim();
  if (/^[+\d\s()-]+$/.test(userId)) {
    const digits = userId.replace(/\D/g, "");
    return digits ? `${WHATSAPP_PREFIX}${digits}` : null;
  }
  return /^\S+$/.test(userId) ? `${WHATSAPP_PREFIX}${userId}` : null;
}

function buildAgenticConfig(
  values: z.infer<typeof environmentSchema>,
): AgentEngineClientConfig {
  const invokeTarget = values.AGENTIC_INVOKE_TARGET;
  const baseUrl = (
    values.AGENTIC_BASE_URL ??
    (invokeTarget === "local"
      ? "http://localhost:3000"
      : "https://agentic-platform.mongodb.com")
  ).replace(/\/+$/, "");
  if (invokeTarget === "local") {
    return { baseUrl, invokeTarget };
  }
  return {
    baseUrl,
    invokeTarget,
    projectId: values.AGENTIC_PROJECT_ID!,
    serviceAccount: {
      clientId: values.AGENTIC_SA_CLIENT_ID!,
      clientSecret: values.AGENTIC_SA_CLIENT_SECRET!,
    },
    workspaceId: values.AGENTIC_WORKSPACE_ID!,
  };
}
