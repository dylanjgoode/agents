import { App, LogLevel, type Receiver } from "@slack/bolt";

import type { SlackBotConfig } from "./config.js";
import {
  registerSlackListeners,
  type SlackListenerDependencies,
} from "./slack/registerListeners.js";

const clientOptions = {
  timeout: 30_000,
  retryConfig: { retries: 0 },
  rejectRateLimitedCalls: true,
};

export function createSocketModeApp(
  config: SlackBotConfig,
  dependencies: SlackListenerDependencies,
): App {
  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
    ignoreSelf: true,
    logLevel: LogLevel.INFO,
    clientOptions,
  });
  registerSlackListeners(app, dependencies);
  return app;
}

export function createHttpModeApp(
  config: SlackBotConfig,
  receiver: Receiver,
  dependencies: SlackListenerDependencies,
): App {
  const app = new App({
    token: config.slack.botToken,
    signingSecret: config.slack.signingSecret,
    receiver,
    deferInitialization: true,
    ignoreSelf: true,
    logLevel: LogLevel.INFO,
    clientOptions,
  });
  registerSlackListeners(app, dependencies);
  return app;
}
