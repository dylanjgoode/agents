import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bootstrapAtlasMcp = vi.hoisted(() =>
  vi.fn(async () => ({
    orgId: "org-1",
    mcpConfigId: "cfg-1",
    mcpConfigName: "mongodb-agent-template",
    clientId: "client-1",
    clientSecret: "secret-1",
  })),
);

const getToken = vi.hoisted(() => vi.fn(async () => "bearer-token"));

vi.mock("./bootstrap.js", () => ({
  bootstrapAtlasMcp,
}));

vi.mock("./oauth.js", () => ({
  createTokenManager: vi.fn(() => ({ getToken })),
  createAtlasMcpAuthProvider: vi.fn(() => ({ kind: "auth-provider" })),
  getMcpBaseUrl: vi.fn(() => "https://mcp.mongodb.com"),
}));

vi.mock("@langchain/mcp-adapters", () => ({
  MultiServerMCPClient: vi.fn(function MultiServerMCPClient(
    this: { config: unknown; getTools: () => Promise<{ name: string }[]> },
    config: unknown,
  ) {
    this.config = config;
    this.getTools = vi.fn(async () => [
      { name: "find" },
      { name: "atlas-local-connect" },
      { name: "mongodb__atlas-local-list" },
      { name: "drop-database" },
    ]);
  }),
}));

import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import {
  createAtlasMcpClient,
  excludeLocalAtlasTools,
  getMcpTools,
  getTools,
  isLocalAtlasTool,
} from "./client.js";

describe("isLocalAtlasTool / excludeLocalAtlasTools", () => {
  it("detects atlas-local tools including MCP server prefixes", () => {
    expect(isLocalAtlasTool("atlas-local-connect")).toBe(true);
    expect(isLocalAtlasTool("mongodb__atlas-local-list")).toBe(true);
    expect(isLocalAtlasTool("find")).toBe(false);
    expect(isLocalAtlasTool("drop-database")).toBe(false);
    expect(isLocalAtlasTool("mongodb__find")).toBe(false);
  });

  it("filters atlas-local tools from a list", () => {
    expect(
      excludeLocalAtlasTools([
        { name: "find" },
        { name: "atlas-local-connect" },
        { name: "mongodb__atlas-local-list" },
        { name: "update-many" },
      ]).map((t) => t.name),
    ).toEqual(["find", "update-many"]);
  });
});

describe("createAtlasMcpClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getToken.mockResolvedValue("bearer-token");
    bootstrapAtlasMcp.mockResolvedValue({
      orgId: "org-1",
      mcpConfigId: "cfg-1",
      mcpConfigName: "mongodb-agent-template",
      clientId: "client-1",
      clientSecret: "secret-1",
    });
  });

  it("bootstraps credentials and builds an HTTP MCP client with bearer auth", async () => {
    const client = await createAtlasMcpClient();

    expect(bootstrapAtlasMcp).toHaveBeenCalledOnce();
    expect(getToken).toHaveBeenCalled();
    expect(MultiServerMCPClient).toHaveBeenCalledOnce();

    const config = vi.mocked(MultiServerMCPClient).mock.calls[0]![0] as {
      mcpServers: { mongodb: { url: string; transport: string } };
      beforeToolCall: () => Promise<{ headers: { Authorization: string } }>;
    };
    expect(config.mcpServers.mongodb.url).toBe("https://mcp.mongodb.com");
    expect(config.mcpServers.mongodb.transport).toBe("http");

    const extra = await config.beforeToolCall();
    expect(extra.headers.Authorization).toBe("Bearer bearer-token");
    expect(client).toBeInstanceOf(MultiServerMCPClient);
  });
});

describe("getMcpTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getToken.mockResolvedValue("bearer-token");
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("loads tools and drops atlas-local entries", async () => {
    const tools = await getMcpTools();
    expect(tools.map((t) => t.name)).toEqual(["find", "drop-database"]);
  });

  it("is aliased as getTools", () => {
    expect(getTools).toBe(getMcpTools);
  });

  it("clears the cache when the first load fails so a later call can retry", async () => {
    vi.resetModules();
    vi.doMock("./bootstrap.js", () => ({
      bootstrapAtlasMcp: vi.fn().mockRejectedValueOnce(new Error("bootstrap failed")),
    }));
    vi.doMock("./oauth.js", () => ({
      createTokenManager: vi.fn(() => ({ getToken: async () => "tok" })),
      createAtlasMcpAuthProvider: vi.fn(() => ({})),
      getMcpBaseUrl: vi.fn(() => "https://mcp.mongodb.com"),
    }));
    vi.doMock("@langchain/mcp-adapters", () => ({
      MultiServerMCPClient: vi.fn(),
    }));

    const { getMcpTools: loadTools } = await import("./client.js");
    await expect(loadTools()).rejects.toThrow("bootstrap failed");
  });
});
