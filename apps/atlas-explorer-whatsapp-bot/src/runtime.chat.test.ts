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

import { createHmac } from "node:crypto";

import { createMockState } from "@chat-adapter/tests";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryThreadStore } from "@repo/agent-engine-chat/store";
import {
  FakeAgentGateway,
  completed,
  suspended,
} from "@repo/agent-engine-chat/testing";

import type { WhatsAppBotConfig } from "./loadConfig.js";
import { READ_ONLY_REJECTION_MESSAGE } from "./readOnlyAgent.js";
import { createRuntime, type BotRuntime } from "./runtime.js";

const BOT_NAME = "TestBot";
const APP_SECRET = "app-secret";
const PHONE_NUMBER_ID = "1234567890";
const ADMIN = "15550001111";
const STRANGER = "15550009999";

interface GraphCall {
  path: string;
  body: Record<string, unknown>;
}

describe("WhatsApp runtime", () => {
  let agent: FakeAgentGateway;
  let graphCalls: GraphCall[];
  let runtime: BotRuntime;
  let pending: Promise<unknown>[];

  beforeEach(async () => {
    graphCalls = [];
    pending = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        graphCalls.push({
          path: new URL(url).pathname,
          body: JSON.parse(String(init?.body ?? "{}")),
        });
        return Response.json({
          messaging_product: "whatsapp",
          messages: [{ id: `wamid.sent-${graphCalls.length}` }],
          success: true,
        });
      }),
    );
    agent = new FakeAgentGateway();
    agent.invokeResult = completed;
    runtime = await createRuntime(config(), {
      agent,
      logger: { error: vi.fn(), warn: vi.fn() },
      state: createMockState(),
      store: new MemoryThreadStore(),
    });
    await runtime.bot.initialize();
  });

  afterEach(async () => {
    await runtime.bot.shutdown();
    vi.unstubAllGlobals();
  });

  async function receive(from: string, id: string, text: string) {
    const body = JSON.stringify(inboundText(from, id, text));
    const response = await runtime.bot.webhooks.whatsapp(
      new Request("https://example.com/api/webhooks/whatsapp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": `sha256=${createHmac("sha256", APP_SECRET)
            .update(body)
            .digest("hex")}`,
        },
        body,
      }),
      { waitUntil: (task) => void pending.push(task) },
    );
    await Promise.all(pending);
    return response;
  }

  function sentTexts(): Array<{ to: unknown; body: unknown }> {
    return graphCalls
      .filter((call) => call.body.type === "text")
      .map((call) => ({
        to: call.body.to,
        body: (call.body.text as { body: unknown }).body,
      }));
  }

  it("answers an allowlisted admin's question", async () => {
    const response = await receive(ADMIN, "wamid.in-1", "Which clusters are running?");

    expect(response.status).toBe(200);
    expect(agent.invokeInputs).toEqual([
      {
        actorId: `whatsapp:${ADMIN}`,
        message: "Which clusters are running?",
        client: "whatsapp",
        user: {
          id: ADMIN,
          username: "Ada Lovelace",
          full_name: "Ada Lovelace",
          actor_id: `whatsapp:${ADMIN}`,
        },
      },
    ]);
    expect(sentTexts()).toEqual([{ to: ADMIN, body: completed.response }]);
  });

  it("continues the admin's agent session on a follow-up", async () => {
    await receive(ADMIN, "wamid.in-1", "How many orders shipped today?");
    await receive(ADMIN, "wamid.in-2", "And last week?");

    expect(agent.invokeInputs.map((input) => input.sessionId)).toEqual([
      undefined,
      completed.sessionId,
    ]);
  });

  it("ignores a redelivered webhook", async () => {
    await receive(ADMIN, "wamid.in-1", "Which clusters are running?");
    await receive(ADMIN, "wamid.in-1", "Which clusters are running?");

    expect(agent.invokeInputs).toHaveLength(1);
  });

  it("turns away numbers that aren't on the allowlist", async () => {
    await receive(STRANGER, "wamid.in-1", "List the databases");

    expect(agent.invokeInputs).toEqual([]);
    expect(sentTexts()).toEqual([
      {
        to: STRANGER,
        body: `You are not authorized to use this ${BOT_NAME} bot.`,
      },
    ]);
  });

  it("rejects proposed writes instead of asking for approval", async () => {
    agent.invokeResult = suspended;
    agent.resumeResult = {
      ...completed,
      response: "I can't change data from WhatsApp.",
    };

    await receive(ADMIN, "wamid.in-1", "Drop the staging collection");

    expect(agent.resumeInputs).toHaveLength(1);
    expect(agent.resumeInputs[0]!.decision).toEqual([
      { type: "reject", message: READ_ONLY_REJECTION_MESSAGE },
    ]);
    expect(
      graphCalls.some((call) => call.body.type === "interactive"),
    ).toBe(false);
    expect(sentTexts()).toEqual([
      { to: ADMIN, body: "I can't change data from WhatsApp." },
    ]);
  });

  it("refuses an unsigned event", async () => {
    const response = await runtime.bot.webhooks.whatsapp(
      new Request("https://example.com/api/webhooks/whatsapp", {
        method: "POST",
        body: JSON.stringify(inboundText(ADMIN, "wamid.in-1", "Hi")),
      }),
    );

    expect(response.status).toBe(401);
    expect(agent.invokeInputs).toEqual([]);
  });

  it("completes Meta's verification handshake", async () => {
    const url = new URL("https://example.com/api/webhooks/whatsapp");
    url.searchParams.set("hub.mode", "subscribe");
    url.searchParams.set("hub.verify_token", "verify-token");
    url.searchParams.set("hub.challenge", "challenge-123");

    const response = await runtime.bot.webhooks.whatsapp(new Request(url));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("challenge-123");
  });
});

function inboundText(from: string, id: string, text: string) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "15550000000",
                phone_number_id: PHONE_NUMBER_ID,
              },
              contacts: [{ profile: { name: "Ada Lovelace" }, wa_id: from }],
              messages: [
                {
                  from,
                  id,
                  timestamp: "1720000000",
                  type: "text",
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function config(): WhatsAppBotConfig {
  return {
    mode: "local",
    chat: { allowedActorIds: [`whatsapp:${ADMIN}`] },
    whatsapp: {
      accessToken: "access-token",
      appSecret: APP_SECRET,
      botDisplayName: BOT_NAME,
      phoneNumberId: PHONE_NUMBER_ID,
      verifyToken: "verify-token",
    },
    agentEngine: {
      baseUrl: "http://localhost:3000",
      invokeTarget: "local",
    },
    sessionLimit: { idleTtlSeconds: 600, limitPerHour: 30 },
    store: { databaseName: "atlas_explorer_whatsapp_test" },
  };
}
