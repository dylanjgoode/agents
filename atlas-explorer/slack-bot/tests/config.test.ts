import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const sharedEnv = {
  SLACK_BOT_TOKEN: "xoxb-test",
  AGENTIC_API_KEY: "agp_test",
  AGENTIC_PROJECT_ID: "project-1",
  AGENTIC_WORKSPACE_ID: "workspace-1",
  SLACK_ALLOWED_USER_IDS: "U123",
};

describe("loadConfig", () => {
  it("loads Socket Mode without a MongoDB connection", () => {
    const config = loadConfig(
      {
        ...sharedEnv,
        SLACK_APP_TOKEN: "xapp-test",
      },
      "socket",
    );

    expect(config).toEqual({
      mode: "socket",
      slack: {
        appToken: "xapp-test",
        allowedUserIds: ["U123"],
        botDisplayName: "AtlasExplorer",
        botToken: "xoxb-test",
      },
      agentic: {
        apiKey: "agp_test",
        baseUrl: "https://agentic-platform.mongodb.com",
        invokeTarget: "gateway",
        projectId: "project-1",
        workspaceId: "workspace-1",
      },
      store: {
        databaseName: "atlas_explorer_slack",
      },
    });
  });

  it("requires persistent storage and request signing in HTTP mode", () => {
    expect(() => loadConfig(sharedEnv, "http")).toThrow(
      /SLACK_SIGNING_SECRET.*MONGODB_URI/s,
    );
  });

  it("requires and parses an explicit Slack user allowlist in HTTP mode", () => {
    const httpEnv = {
      ...sharedEnv,
      SLACK_SIGNING_SECRET: "signing-secret",
      MONGODB_URI: "mongodb://localhost:27017",
      SLACK_ALLOWED_USER_IDS: undefined,
    };
    expect(() => loadConfig(httpEnv, "http")).toThrow(
      /SLACK_ALLOWED_USER_IDS/,
    );

    const config = loadConfig(
      {
        ...httpEnv,
        SLACK_ALLOWED_USER_IDS: " U123, U456 ,U123 ",
      },
      "http",
    );
    expect(config.slack.allowedUserIds).toEqual(["U123", "U456"]);
  });

  it("normalizes an Agentic base URL before requests are built", () => {
    const config = loadConfig(
      {
        ...sharedEnv,
        SLACK_APP_TOKEN: "xapp-test",
        AGENTIC_BASE_URL: "https://agentic.example.test///",
      },
      "socket",
    );

    expect(config.agentic.baseUrl).toBe("https://agentic.example.test");
  });

  it("selects the local Playground invoke contract explicitly", () => {
    const config = loadConfig(
      {
        SLACK_BOT_TOKEN: "xoxb-test",
        SLACK_ALLOWED_USER_IDS: "U123",
        SLACK_APP_TOKEN: "xapp-test",
        AGENTIC_INVOKE_TARGET: "local",
        AGENTIC_BASE_URL: "",
        AGENTIC_API_KEY: "",
        AGENTIC_PROJECT_ID: "",
        AGENTIC_WORKSPACE_ID: "",
        SLACK_SIGNING_SECRET: "",
        MONGODB_URI: "",
      },
      "socket",
    );

    expect(config.agentic.invokeTarget).toBe("local");
    expect(config.agentic.baseUrl).toBe("http://localhost:3000");
    expect(config.agentic.apiKey).toBeUndefined();
    expect(config.agentic.projectId).toBe("local");
    expect(config.agentic.workspaceId).toBe("local");
  });

  it("identifies missing shared credentials by environment variable name", () => {
    expect(() =>
      loadConfig(
        {
          SLACK_APP_TOKEN: "xapp-test",
        },
        "socket",
      ),
    ).toThrow(/SLACK_BOT_TOKEN.*AGENTIC_API_KEY.*AGENTIC_PROJECT_ID.*AGENTIC_WORKSPACE_ID/s);
  });
});
