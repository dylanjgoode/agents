import "dotenv/config";

import { loadConfig } from "./config.js";
import { createSocketRuntime } from "./runtime.js";

const config = loadConfig(process.env, "socket");
const { app, store } = await createSocketRuntime(config);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  await Promise.allSettled([app.stop(), store.close()]);
}

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});

try {
  await app.start();
  console.log(
    `⚡️ ${config.slack.botDisplayName} is running in Slack Socket Mode`,
  );
} catch (error) {
  await store.close();
  throw error;
}
