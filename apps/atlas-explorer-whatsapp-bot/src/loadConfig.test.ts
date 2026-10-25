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

import { describe, expect, it } from "vitest";

import { loadConfig, parseWhatsAppActorId } from "./loadConfig.js";

const gatewayEnvironment = {
  WHATSAPP_ACCESS_TOKEN: "access-token",
  WHATSAPP_APP_SECRET: "app-secret",
  WHATSAPP_PHONE_NUMBER_ID: "1234567890",
  WHATSAPP_VERIFY_TOKEN: "verify-token",
  CHAT_ALLOWED_USER_IDS: "whatsapp:15550001111",
  AGENTIC_SA_CLIENT_ID: "client-id",
  AGENTIC_SA_CLIENT_SECRET: "client-secret",
  AGENTIC_PROJECT_ID: "project-id",
  AGENTIC_WORKSPACE_ID: "workspace-id",
  MONGODB_URI: "mongodb://127.0.0.1:27017",
};

describe("loadConfig", () => {
  it("loads a gateway deployment with defaults", () => {
    expect(loadConfig(gatewayEnvironment, "http")).toEqual({
      mode: "http",
      chat: { allowedActorIds: ["whatsapp:15550001111"] },
      whatsapp: {
        accessToken: "access-token",
        appSecret: "app-secret",
        phoneNumberId: "1234567890",
        verifyToken: "verify-token",
        botDisplayName: "AtlasExplorer",
      },
      agentEngine: {
        baseUrl: "https://agentic-platform.mongodb.com",
        invokeTarget: "gateway",
        projectId: "project-id",
        serviceAccount: {
          clientId: "client-id",
          clientSecret: "client-secret",
        },
        workspaceId: "workspace-id",
      },
      sessionLimit: { idleTtlSeconds: 600, limitPerHour: 40 },
      store: {
        mongoUri: "mongodb://127.0.0.1:27017",
        databaseName: "atlas_explorer_whatsapp",
      },
    });
  });

  it("reads optional overrides", () => {
    const config = loadConfig(
      {
        ...gatewayEnvironment,
        WHATSAPP_API_URL: "http://127.0.0.1:4012",
        WHATSAPP_BOT_DISPLAY_NAME: "OpsBot",
        AGENTIC_BASE_URL: "https://agents.example.com/",
        SESSION_LIMIT_PER_HOUR: "10",
        SESSION_IDLE_TTL_SECONDS: "300",
        THREAD_STORE_DB: "ops_chat",
      },
      "http",
    );

    expect(config.whatsapp.apiUrl).toBe("http://127.0.0.1:4012");
    expect(config.whatsapp.botDisplayName).toBe("OpsBot");
    expect(config.agentEngine.baseUrl).toBe("https://agents.example.com");
    expect(config.sessionLimit).toEqual({
      idleTtlSeconds: 300,
      limitPerHour: 10,
    });
    expect(config.store.databaseName).toBe("ops_chat");
  });

  it("targets a local agent without gateway credentials", () => {
    const {
      AGENTIC_SA_CLIENT_ID: _id,
      AGENTIC_SA_CLIENT_SECRET: _secret,
      AGENTIC_PROJECT_ID: _project,
      AGENTIC_WORKSPACE_ID: _workspace,
      MONGODB_URI: _uri,
      ...environment
    } = gatewayEnvironment;

    const config = loadConfig(
      { ...environment, AGENTIC_INVOKE_TARGET: "local" },
      "local",
    );

    expect(config.agentEngine).toEqual({
      baseUrl: "http://localhost:3000",
      invokeTarget: "local",
    });
    expect(config.store).toEqual({
      databaseName: "atlas_explorer_whatsapp",
    });
  });

  it("requires MongoDB in HTTP mode", () => {
    const { MONGODB_URI: _uri, ...environment } = gatewayEnvironment;

    expect(() => loadConfig(environment, "http")).toThrow(
      "MONGODB_URI is required in HTTP mode",
    );
    expect(() => loadConfig(environment, "local")).not.toThrow();
  });

  it("names every missing WhatsApp and gateway variable", () => {
    expect(() =>
      loadConfig(
        { CHAT_ALLOWED_USER_IDS: "whatsapp:15550001111" },
        "local",
      ),
    ).toThrow(
      "Invalid environment: WHATSAPP_ACCESS_TOKEN is required; " +
        "WHATSAPP_APP_SECRET is required; " +
        "WHATSAPP_PHONE_NUMBER_ID is required; " +
        "WHATSAPP_VERIFY_TOKEN is required",
    );
    expect(() =>
      loadConfig(
        { ...gatewayEnvironment, AGENTIC_WORKSPACE_ID: " " },
        "http",
      ),
    ).toThrow("AGENTIC_WORKSPACE_ID is required for the gateway target");
  });

  it("requires an allowlist of WhatsApp IDs", () => {
    for (const allowlist of ["", " , ", "slack:U123", "15550001111"]) {
      expect(() =>
        loadConfig(
          { ...gatewayEnvironment, CHAT_ALLOWED_USER_IDS: allowlist },
          "http",
        ),
      ).toThrow(/CHAT_ALLOWED_USER_IDS/);
    }
  });

  it("normalizes and deduplicates the allowlist", () => {
    const config = loadConfig(
      {
        ...gatewayEnvironment,
        CHAT_ALLOWED_USER_IDS:
          "whatsapp:+44 7700 900123, WhatsApp:447700900123, " +
          "whatsapp:US.13491208655302741918",
      },
      "http",
    );

    expect(config.chat.allowedActorIds).toEqual([
      "whatsapp:447700900123",
      "whatsapp:US.13491208655302741918",
    ]);
  });
});

describe("parseWhatsAppActorId", () => {
  it("keeps only digits from a phone number", () => {
    expect(parseWhatsAppActorId("whatsapp:+1 (555) 000-1111")).toBe(
      "whatsapp:15550001111",
    );
  });

  it("rejects entries for other platforms or without an ID", () => {
    expect(parseWhatsAppActorId("slack:U123")).toBeNull();
    expect(parseWhatsAppActorId("whatsapp:")).toBeNull();
    expect(parseWhatsAppActorId("whatsapp:+")).toBeNull();
    expect(parseWhatsAppActorId("whatsapp:two words")).toBeNull();
  });
});
