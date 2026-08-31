import type { McpCredentials } from "./bootstrap.js";

const DEFAULT_MCP_BASE_URL = "https://mcp.mongodb.com";
const DEFAULT_TOKEN_TIMEOUT_MS = 10_000;
const TOKEN_EXPIRY_BUFFER_MS = 10 * 60 * 1000;

const MCP_BASE_URL_TO_OAUTH_BASE: Readonly<Record<string, string>> = {
  "https://mcp.mongodb.com": "https://cloud.mongodb.com",
  "https://mcp-dev.mongodb.com": "https://cloud-dev.mongodb.com",
  "https://mcp-qa.mongodb.com": "https://cloud-qa.mongodb.com",
  "https://mcp-stage.mongodb.com": "https://cloud-stage.mongodb.com",
};

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
};

type CachedToken = {
  accessToken: string;
  expiresAt: number;
};

export class TokenError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "TokenError";
  }
}

/**
 * Client-credentials token fetch / cache / refresh, matching
 * mongodb-atlas-mcp-remote TokenManager.
 */
export class TokenManager {
  private cachedToken: CachedToken | null = null;
  private refreshPromise: Promise<string> | null = null;

  constructor(
    private readonly tokenUrl: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly timeoutMs = DEFAULT_TOKEN_TIMEOUT_MS,
  ) {}

  async getToken(): Promise<string> {
    if (
      this.cachedToken &&
      Date.now() < this.cachedToken.expiresAt - TOKEN_EXPIRY_BUFFER_MS
    ) {
      return this.cachedToken.accessToken;
    }

    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.fetchToken()
      .then((token) => {
        this.cachedToken = token;
        this.refreshPromise = null;
        return token.accessToken;
      })
      .catch((error: unknown) => {
        this.refreshPromise = null;
        throw error;
      });

    return this.refreshPromise;
  }

  invalidateToken(): void {
    this.cachedToken = null;
  }

  private async fetchToken(): Promise<CachedToken> {
    const credentials = Buffer.from(
      `${this.clientId}:${this.clientSecret}`,
    ).toString("base64");

    let response: Response;
    try {
      response = await fetch(this.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          Authorization: `Basic ${credentials}`,
        },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error: unknown) {
      const isTimeout = error instanceof Error && error.name === "TimeoutError";
      throw new TokenError(
        isTimeout
          ? `Token request timed out after ${this.timeoutMs}ms`
          : `Token request failed: ${String(error)}`,
        0,
      );
    }

    if (!response.ok) {
      const body = await response.text();
      throw new TokenError(
        `Token request failed with status ${response.status}: ${body}`,
        response.status,
      );
    }

    const data = (await response.json()) as TokenResponse;
    if (!data.access_token) {
      throw new TokenError("Token response missing access_token", 0);
    }

    const expiresInS = data.expires_in ?? 3600;
    return {
      accessToken: data.access_token,
      expiresAt: Date.now() + expiresInS * 1000,
    };
  }
}

export function getMcpBaseUrl(): string {
  const fromEnv = process.env.MDB_MCP_API_BASE_URL?.replace(/\/+$/, "");
  return fromEnv || DEFAULT_MCP_BASE_URL;
}

export function getOAuthTokenUrl(mcpBaseUrl = getMcpBaseUrl()): string {
  const oauthBase = MCP_BASE_URL_TO_OAUTH_BASE[mcpBaseUrl] ?? mcpBaseUrl;
  return new URL("/api/oauth/token", oauthBase).toString();
}

const tokenManagers = new Map<string, TokenManager>();

export function createTokenManager(credentials: McpCredentials): TokenManager {
  const cacheKey = `${credentials.clientId}\0${credentials.clientSecret}`;
  const cached = tokenManagers.get(cacheKey);
  if (cached) {
    return cached;
  }
  const timeoutMs = Number.parseInt(
    process.env.MDB_MCP_TOKEN_TIMEOUT_MS ?? "",
    10,
  );
  const manager = new TokenManager(
    getOAuthTokenUrl(),
    credentials.clientId,
    credentials.clientSecret,
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_TOKEN_TIMEOUT_MS,
  );
  tokenManagers.set(cacheKey, manager);
  return manager;
}

export async function getAccessToken(
  credentials: McpCredentials,
  manager = createTokenManager(credentials),
): Promise<string> {
  return manager.getToken();
}

/**
 * MCP SDK auth provider that attaches a Bearer token from TokenManager
 * and refreshes before expiry. Interactive OAuth is not used.
 */
export class AtlasMcpAuthProvider {
  constructor(
    private readonly tokenManager: TokenManager,
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  get redirectUrl(): undefined {
    return undefined;
  }

  get clientMetadata() {
    return {
      client_name: "mongodb-agent-template",
      redirect_uris: [] as string[],
      grant_types: ["client_credentials"],
      token_endpoint_auth_method: "client_secret_basic",
    };
  }

  clientInformation() {
    return {
      client_id: this.clientId,
      client_secret: this.clientSecret,
    };
  }

  saveClientInformation(): void {}

  async tokens() {
    const access_token = await this.tokenManager.getToken();
    return { access_token, token_type: "Bearer" };
  }

  saveTokens(): void {}

  redirectToAuthorization(): void {
    throw new Error(
      "Interactive OAuth is not used for Atlas Managed MCP; tokens are fetched with client credentials.",
    );
  }

  saveCodeVerifier(): void {}

  codeVerifier(): string {
    throw new Error("PKCE is not used for Atlas Managed MCP client credentials.");
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "tokens" || scope === "all") {
      this.tokenManager.invalidateToken();
    }
  }

  prepareTokenRequest(): URLSearchParams {
    return new URLSearchParams({ grant_type: "client_credentials" });
  }
}

export function createAtlasMcpAuthProvider(
  credentials: McpCredentials,
  tokenManager = createTokenManager(credentials),
): AtlasMcpAuthProvider {
  return new AtlasMcpAuthProvider(
    tokenManager,
    credentials.clientId,
    credentials.clientSecret,
  );
}
