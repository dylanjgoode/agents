import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AtlasMcpAuthProvider,
  createAtlasMcpAuthProvider,
  createTokenManager,
  getAccessToken,
  getMcpBaseUrl,
  getOAuthTokenUrl,
  TokenError,
  TokenManager,
} from "./oauth.js";
import type { McpCredentials } from "./bootstrap.js";

function credentials(clientId: string): McpCredentials {
  return {
    orgId: "org",
    mcpConfigId: "cfg",
    mcpConfigName: "mongodb-agent-template",
    clientId,
    clientSecret: "secret",
  };
}

describe("MCP URL helpers", () => {
  const originalBase = process.env.MDB_MCP_API_BASE_URL;

  afterEach(() => {
    if (originalBase === undefined) {
      delete process.env.MDB_MCP_API_BASE_URL;
    } else {
      process.env.MDB_MCP_API_BASE_URL = originalBase;
    }
  });

  it("defaults MCP base URL to mcp.mongodb.com", () => {
    delete process.env.MDB_MCP_API_BASE_URL;
    expect(getMcpBaseUrl()).toBe("https://mcp.mongodb.com");
  });

  it("strips trailing slashes from MDB_MCP_API_BASE_URL", () => {
    process.env.MDB_MCP_API_BASE_URL = "https://mcp-qa.mongodb.com///";
    expect(getMcpBaseUrl()).toBe("https://mcp-qa.mongodb.com");
  });

  it("maps known MCP hosts to cloud OAuth token URLs", () => {
    expect(getOAuthTokenUrl("https://mcp.mongodb.com")).toBe(
      "https://cloud.mongodb.com/api/oauth/token",
    );
    expect(getOAuthTokenUrl("https://mcp-dev.mongodb.com")).toBe(
      "https://cloud-dev.mongodb.com/api/oauth/token",
    );
    expect(getOAuthTokenUrl("https://mcp-qa.mongodb.com")).toBe(
      "https://cloud-qa.mongodb.com/api/oauth/token",
    );
    expect(getOAuthTokenUrl("https://mcp-stage.mongodb.com")).toBe(
      "https://cloud-stage.mongodb.com/api/oauth/token",
    );
  });

  it("uses the MCP host as OAuth base when the host is unknown", () => {
    expect(getOAuthTokenUrl("https://mcp.example.internal")).toBe(
      "https://mcp.example.internal/api/oauth/token",
    );
  });
});

describe("TokenManager", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("fetches, caches, and reuses a token until near expiry", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "tok-1", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const manager = new TokenManager(
      "https://cloud.mongodb.com/api/oauth/token",
      "id",
      "sec",
    );

    await expect(manager.getToken()).resolves.toBe("tok-1");
    await expect(manager.getToken()).resolves.toBe("tok-1");
    expect(fetchMock).toHaveBeenCalledOnce();

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe("grant_type=client_credentials");
    const auth = new Headers(init.headers).get("Authorization");
    expect(auth).toBe(`Basic ${Buffer.from("id:sec").toString("base64")}`);
  });

  it("refetches after invalidateToken", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n += 1;
        return new Response(
          JSON.stringify({ access_token: `tok-${n}`, expires_in: 3600 }),
          { status: 200 },
        );
      }),
    );

    const manager = new TokenManager("https://example/token", "id", "sec");
    await expect(manager.getToken()).resolves.toBe("tok-1");
    manager.invalidateToken();
    await expect(manager.getToken()).resolves.toBe("tok-2");
  });

  it("throws TokenError when the token endpoint fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("denied", { status: 401 })),
    );

    const manager = new TokenManager("https://example/token", "id", "sec");
    await expect(manager.getToken()).rejects.toMatchObject({
      name: "TokenError",
      statusCode: 401,
      message: expect.stringContaining("401"),
    });
  });

  it("throws TokenError when access_token is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ expires_in: 60 }), { status: 200 }),
      ),
    );

    const manager = new TokenManager("https://example/token", "id", "sec");
    await expect(manager.getToken()).rejects.toThrow(TokenError);
    await expect(manager.getToken()).rejects.toThrow(/missing access_token/);
  });

  it("wraps fetch timeouts as TokenError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const err = new Error("aborted");
        err.name = "TimeoutError";
        throw err;
      }),
    );

    const manager = new TokenManager("https://example/token", "id", "sec", 50);
    await expect(manager.getToken()).rejects.toThrow(
      /Token request timed out after 50ms/,
    );
  });
});

describe("createTokenManager / getAccessToken", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reuses a TokenManager per clientId", () => {
    const creds = credentials(`reuse-${Date.now()}`);
    const a = createTokenManager(creds);
    const b = createTokenManager(creds);
    expect(a).toBe(b);
  });

  it("getAccessToken returns the manager token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ access_token: "via-helper" }), {
            status: 200,
          }),
      ),
    );

    const manager = new TokenManager("https://example/token", "id", "sec");
    await expect(getAccessToken(credentials("other"), manager)).resolves.toBe(
      "via-helper",
    );
  });
});

describe("AtlasMcpAuthProvider", () => {
  let manager: TokenManager;

  beforeEach(() => {
    manager = new TokenManager("https://example/token", "cid", "csec");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ access_token: "bearer-tok" }), {
            status: 200,
          }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exposes client-credentials metadata and tokens", async () => {
    const provider = new AtlasMcpAuthProvider(manager, "cid", "csec");

    expect(provider.redirectUrl).toBeUndefined();
    expect(provider.clientMetadata.grant_types).toEqual(["client_credentials"]);
    expect(provider.clientInformation()).toEqual({
      client_id: "cid",
      client_secret: "csec",
    });
    expect(provider.prepareTokenRequest().get("grant_type")).toBe(
      "client_credentials",
    );
    await expect(provider.tokens()).resolves.toEqual({
      access_token: "bearer-tok",
      token_type: "Bearer",
    });
  });

  it("rejects interactive OAuth and PKCE", () => {
    const provider = createAtlasMcpAuthProvider(credentials(`auth-${Date.now()}`), manager);
    expect(() => provider.redirectToAuthorization()).toThrow(/Interactive OAuth is not used/);
    expect(() => provider.codeVerifier()).toThrow(/PKCE is not used/);
  });

  it("invalidates cached tokens for tokens/all scopes", async () => {
    const provider = new AtlasMcpAuthProvider(manager, "cid", "csec");
    await provider.tokens();
    provider.invalidateCredentials("tokens");

    const fetchMock = vi.mocked(fetch);
    fetchMock.mockClear();
    await provider.tokens();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
