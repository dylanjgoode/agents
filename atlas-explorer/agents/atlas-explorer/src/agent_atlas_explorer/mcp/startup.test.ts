import { describe, expect, it, vi } from "vitest";

import { createAtlasMcpStartup } from "./startup.js";

const credentials = {
  orgId: "atlas-org-1",
  mcpConfigId: "config-1",
  mcpConfigName: "atlas-explorer-startup-a",
  clientId: "client-1",
  clientSecret: "one-time-secret",
};

describe("createAtlasMcpStartup", () => {
  it("injects generated client credentials before Magenta reads agent.yaml", async () => {
    const env: NodeJS.ProcessEnv = {};
    const log = vi.fn();
    const prepare = createAtlasMcpStartup({
      bootstrap: async () => credentials,
      env,
      log,
    });

    const result = await prepare();

    expect(env.ATLAS_MCP_CLIENT_ID).toBe("client-1");
    expect(env.ATLAS_MCP_CLIENT_SECRET).toBe("one-time-secret");
    expect(result).toEqual({
      mcpConfigId: "config-1",
      mcpConfigName: "atlas-explorer-startup-a",
      clientId: "client-1",
    });
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls.flat().join(" ")).not.toContain("one-time-secret");
  });

  it("runs bootstrap once for concurrent startup consumers", async () => {
    const bootstrap = vi.fn(async () => credentials);
    const prepare = createAtlasMcpStartup({
      bootstrap,
      env: {},
      log: vi.fn(),
    });

    const [first, second] = await Promise.all([prepare(), prepare()]);

    expect(bootstrap).toHaveBeenCalledOnce();
    expect(first).toBe(second);
  });
});
