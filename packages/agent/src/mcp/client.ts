import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import type { DynamicStructuredTool } from "@langchain/core/tools";
import { bootstrapAtlasMcp } from "./bootstrap.js";
import {
  createAtlasMcpAuthProvider,
  createTokenManager,
  getMcpBaseUrl,
  type TokenManager,
} from "./oauth.js";

const LOCAL_ATLAS_TOOL_PREFIX = "atlas-local-";

let toolsPromise: Promise<DynamicStructuredTool[]> | undefined;

export function isLocalAtlasTool(name: string): boolean {
  const bareName = name.includes("__")
    ? name.slice(name.lastIndexOf("__") + 2)
    : name;
  return bareName.startsWith(LOCAL_ATLAS_TOOL_PREFIX);
}

export function excludeLocalAtlasTools<T extends { name: string }>(
  tools: T[],
): T[] {
  return tools.filter((tool) => !isLocalAtlasTool(tool.name));
}

/**
 * Streamable HTTP client for `https://mcp.mongodb.com` with Bearer token auth.
 */
export async function createAtlasMcpClient(
  tokenManager?: TokenManager,
): Promise<MultiServerMCPClient> {
  const credentials = await bootstrapAtlasMcp();
  const manager = tokenManager ?? createTokenManager(credentials);
  await manager.getToken();

  return new MultiServerMCPClient({
    mcpServers: {
      mongodb: {
        url: getMcpBaseUrl(),
        transport: "http",
        automaticSSEFallback: false,
        authProvider: createAtlasMcpAuthProvider(credentials, manager),
      },
    },
    beforeToolCall: async () => ({
      headers: {
        Authorization: `Bearer ${await manager.getToken()}`,
      },
    }),
  });
}

/**
 * Load Atlas Managed MCP tools for `createDeepAgent({ tools })`.
 * Bootstraps org MCP config if needed, attaches a refreshed Bearer token,
 * and drops any `atlas-local-*` tools.
 */
export async function getMcpTools(): Promise<DynamicStructuredTool[]> {
  toolsPromise ??= (async () => {
    const client = await createAtlasMcpClient();
    const tools = await client.getTools();
    return excludeLocalAtlasTools(tools);
  })().catch((error: unknown) => {
    toolsPromise = undefined;
    throw error;
  });
  return toolsPromise;
}

export const getTools = getMcpTools;
