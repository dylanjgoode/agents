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

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startLocalWebhookServer,
  WEBHOOK_PATH,
  type LocalWebhookServer,
} from "./localWebhookServer.js";
import type { AtlasExplorerChat } from "./runtime.js";

describe("local webhook server", () => {
  let server: LocalWebhookServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function start(
    webhook: (
      request: Request,
      options: { waitUntil: (task: Promise<unknown>) => void },
    ) => Promise<Response>,
  ) {
    const bot = { webhooks: { whatsapp: vi.fn(webhook) } };
    server = await startLocalWebhookServer(
      bot as unknown as AtlasExplorerChat,
    );
    return bot.webhooks.whatsapp;
  }

  it("forwards the verification query and signed body", async () => {
    const webhook = await start(async (request) =>
      new Response(
        request.method === "GET"
          ? new URL(request.url).searchParams.get("hub.challenge")
          : await request.text(),
      ),
    );

    const verify = await fetch(
      `${server!.url}${WEBHOOK_PATH}?hub.challenge=abc`,
    );
    const event = await fetch(`${server!.url}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=signed" },
      body: '{"entry":[]}',
    });

    await expect(verify.text()).resolves.toBe("abc");
    await expect(event.text()).resolves.toBe('{"entry":[]}');
    expect(
      webhook.mock.calls[1]![0].headers.get("x-hub-signature-256"),
    ).toBe("sha256=signed");
  });

  it("waits for background work before closing", async () => {
    let finish!: () => void;
    const work = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let finished = false;
    await start(async (_request, { waitUntil }) => {
      waitUntil(work.then(() => {
        finished = true;
      }));
      return new Response("ok");
    });
    await fetch(`${server!.url}${WEBHOOK_PATH}`, {
      method: "POST",
      body: "{}",
    });

    const closing = server!.close();
    server = undefined;
    finish();
    await closing;

    expect(finished).toBe(true);
  });

  it("serves a health check and nothing else", async () => {
    const webhook = await start(async () => new Response("ok"));

    const health = await fetch(`${server!.url}/health`);
    const other = await fetch(`${server!.url}/api/webhooks/slack`, {
      method: "POST",
    });

    expect(health.status).toBe(200);
    expect(other.status).toBe(404);
    expect(webhook).not.toHaveBeenCalled();
  });
});
