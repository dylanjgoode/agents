import {
  bootstrapAtlasMcp,
  type AtlasMcpCredentials,
} from "./bootstrap.js";

export const MCP_CLIENT_ID_ENV = "ATLAS_MCP_CLIENT_ID";
export const MCP_CLIENT_SECRET_ENV = "ATLAS_MCP_CLIENT_SECRET";

export interface AtlasMcpStartupResult {
  mcpConfigId: string;
  mcpConfigName: string;
  clientId: string;
}

export interface AtlasMcpStartupOptions {
  bootstrap?: () => Promise<AtlasMcpCredentials>;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

/**
 * Build a process-scoped startup function.
 *
 * AER and Tool Pod processes each evaluate the agent module independently.
 * Memoizing here creates one Atlas MCP identity per process while allowing
 * concurrent startup consumers to share the same in-flight bootstrap.
 */
export function createAtlasMcpStartup(
  options: AtlasMcpStartupOptions = {},
): () => Promise<AtlasMcpStartupResult> {
  const bootstrap = options.bootstrap ?? (() => bootstrapAtlasMcp());
  const env = options.env ?? process.env;
  const log = options.log ?? ((message: string) => console.info(message));
  let startupPromise: Promise<AtlasMcpStartupResult> | undefined;

  return () => {
    startupPromise ??= bootstrap()
      .then((credentials) => {
        env[MCP_CLIENT_ID_ENV] = credentials.clientId;
        env[MCP_CLIENT_SECRET_ENV] = credentials.clientSecret;

        const result = {
          mcpConfigId: credentials.mcpConfigId,
          mcpConfigName: credentials.mcpConfigName,
          clientId: credentials.clientId,
        };
        log(
          `[Atlas MCP] Created process identity "${result.mcpConfigName}" (${result.mcpConfigId})`,
        );
        return result;
      })
      .catch((error: unknown) => {
        startupPromise = undefined;
        throw error;
      });
    return startupPromise;
  };
}

export const prepareAtlasMcpEnvironment = createAtlasMcpStartup();
