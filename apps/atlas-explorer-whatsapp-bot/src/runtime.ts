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

import type { WhatsAppAdapter } from "@chat-adapter/whatsapp";
import { Chat, type StateAdapter } from "chat";

import {
  registerChatHandlers,
  type AgentGateway,
  type HandlerLogger,
} from "@repo/agent-engine-chat/chat";
import { AgentEngineClient } from "@repo/agent-engine-chat/agent-engine";
import {
  getSharedMongoConnection,
  MongoStateAdapter,
  MongoThreadStore,
  type MongoConnection,
  type ThreadStore,
} from "@repo/agent-engine-chat/store";

import { atlasExplorerChatMessages } from "./atlasExplorerChat.js";
import {
  loadConfig,
  type WhatsAppBotConfig,
} from "./loadConfig.js";
import { createWhatsAppPlatformAdapter } from "./platforms/whatsapp.js";
import { readOnlyAgent } from "./readOnlyAgent.js";

export type AtlasExplorerChat = Chat<{
  whatsapp: WhatsAppAdapter;
}>;

export interface BotRuntime {
  bot: AtlasExplorerChat;
  whatsappAdapter: WhatsAppAdapter;
  state: StateAdapter;
  store: ThreadStore;
}

interface RuntimeOptions {
  agent?: AgentGateway;
  connection?: MongoConnection;
  logger?: HandlerLogger;
  state?: StateAdapter;
  store?: ThreadStore;
  whatsappAdapter?: WhatsAppAdapter;
}

let httpRuntime: Promise<BotRuntime> | undefined;

export function getHttpRuntime(
  environment: Record<string, string | undefined> = process.env,
): Promise<BotRuntime> {
  if (!httpRuntime) {
    const pending = createRuntime(
      loadConfig(environment, "http"),
    ).catch((error) => {
      if (httpRuntime === pending) {
        httpRuntime = undefined;
      }
      throw error;
    });
    httpRuntime = pending;
  }
  return httpRuntime;
}

/** Drops the cached HTTP runtime after shutdown so the next start reads env again. */
export function resetHttpRuntime(): void {
  httpRuntime = undefined;
}

export async function createRuntime(
  config: WhatsAppBotConfig,
  options: RuntimeOptions = {},
): Promise<BotRuntime> {
  let connection = options.connection;
  if (!options.state || !options.store) {
    connection ??= await getSharedMongoConnection({
      uri: config.store.mongoUri,
      databaseName: config.store.databaseName,
      allowEmbedded: config.mode === "local",
    });
  }

  const state =
    options.state ??
    new MongoStateAdapter({
      client: connection!.client,
      databaseName: config.store.databaseName,
    });
  const store =
    options.store ??
    MongoThreadStore.fromDatabase(connection!.database);
  if (store instanceof MongoThreadStore) {
    await store.initialize();
  }

  const whatsappAdapter =
    options.whatsappAdapter ??
    createWhatsAppPlatformAdapter({
      accessToken: config.whatsapp.accessToken,
      appSecret: config.whatsapp.appSecret,
      displayName: config.whatsapp.botDisplayName,
      phoneNumberId: config.whatsapp.phoneNumberId,
      verifyToken: config.whatsapp.verifyToken,
      ...(config.whatsapp.apiUrl ? { apiUrl: config.whatsapp.apiUrl } : {}),
    });
  const bot = new Chat({
    adapters: { whatsapp: whatsappAdapter },
    concurrency: "concurrent",
    state,
    userName: config.whatsapp.botDisplayName,
  });
  // Every WhatsApp chat is a DM, so the shared direct-message handler runs
  // each turn. One admin's chat is one thread and one agent session, which
  // is how follow-up questions keep their context.
  registerChatHandlers(bot, {
    agent: readOnlyAgent(
      options.agent ?? new AgentEngineClient(config.agentEngine),
    ),
    authorizedActorIds: new Set(config.chat.allowedActorIds),
    botName: config.whatsapp.botDisplayName,
    logger: options.logger ?? console,
    messages: atlasExplorerChatMessages,
    sessionLimit: {
      idleTtlMs: config.sessionLimit.idleTtlSeconds * 1_000,
      limit: config.sessionLimit.limitPerHour,
    },
    store,
  });

  return {
    bot,
    whatsappAdapter,
    state,
    store,
  };
}
