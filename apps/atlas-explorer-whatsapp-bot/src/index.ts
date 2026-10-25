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

import "dotenv/config";

import { closeSharedMongoConnection } from "@repo/agent-engine-chat/store";

import { loadConfig } from "./loadConfig.js";
import { startLocalWebhookServer } from "./localWebhookServer.js";
import { createRuntime } from "./runtime.js";

const config = loadConfig(process.env, "local");
const { bot } = await createRuntime(config);
const port = Number(process.env.PORT ?? 3001);

let server: Awaited<ReturnType<typeof startLocalWebhookServer>> | undefined;
let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  await server?.close();
  await bot.shutdown();
  await closeSharedMongoConnection();
}

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});

try {
  await bot.initialize();
  server = await startLocalWebhookServer(bot, { port });
  console.log(
    `${config.whatsapp.botDisplayName} is listening on ${server.url}/api/webhooks/whatsapp`,
  );
} catch (error) {
  await Promise.allSettled([
    server?.close(),
    bot.shutdown(),
    closeSharedMongoConnection(),
  ]);
  throw error;
}
