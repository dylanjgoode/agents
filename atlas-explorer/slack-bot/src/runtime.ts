import type { Receiver } from "@slack/bolt";

import {
  createHttpModeApp,
  createSocketModeApp,
} from "./app.js";
import type { SlackBotConfig } from "./config.js";
import { MagentaClient } from "./magenta/client.js";
import { MemoryThreadStore } from "./store/memoryThreadStore.js";
import { MongoThreadStore } from "./store/mongoThreadStore.js";
import type { ThreadStore } from "./store/threadStore.js";

export async function createSocketRuntime(config: SlackBotConfig) {
  const store: ThreadStore = config.store.mongoUri
    ? await MongoThreadStore.connect(
        config.store.mongoUri,
        config.store.databaseName,
      )
    : new MemoryThreadStore();
  const agent = new MagentaClient(config.agentic);
  const app = createSocketModeApp(config, {
    agent,
    store,
    displayName: config.slack.botDisplayName,
    authorizedSlackUserIds: new Set(config.slack.allowedUserIds),
  });
  return { app, store };
}

export function createHttpRuntime(
  config: SlackBotConfig,
  receiver: Receiver,
) {
  if (!config.store.mongoUri) {
    throw new Error("MONGODB_URI is required for the HTTP runtime");
  }
  const store = MongoThreadStore.createLazy(
    config.store.mongoUri,
    config.store.databaseName,
  );
  const agent = new MagentaClient(config.agentic);
  const app = createHttpModeApp(config, receiver, {
    agent,
    store,
    displayName: config.slack.botDisplayName,
    authorizedSlackUserIds: new Set(config.slack.allowedUserIds),
  });
  return { app, store };
}
