import { VercelReceiver, createHandler } from "@vercel/slack-bolt";

import { loadConfig } from "../../src/config.js";
import { createHttpRuntime } from "../../src/runtime.js";

export const maxDuration = 300;

const config = loadConfig(process.env, "http");
const receiver = new VercelReceiver({
  signingSecret: config.slack.signingSecret,
});
const { app } = createHttpRuntime(config, receiver);

export const POST = createHandler(app, receiver);
