import { describe, expect, it, vi } from "vitest";

import {
  bootstrapAtlasMcp,
  type AtlasMcpBootstrapOptions,
} from "./bootstrap.js";

const ATLAS_API_PREFIX = "https://cloud.mongodb.com/api/atlas/v2";

function atlasEnv(): NodeJS.ProcessEnv {
  return {
    ATLAS_ORG_ID: "atlas-org-1",
    ATLAS_PUBLIC_API_KEY: "public-key",
    ATLAS_PRIVATE_API_KEY: "private-key",
  };
}

function makeFetch() {
  const authenticatedRequests: Array<{
    url: string;
    init: RequestInit;
  }> = [];

  const fetch = vi.fn(
    async (input: string | URL | Request, init: RequestInit = {}) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;

      if (url === "https://api4.ipify.org") {
        return new Response("203.0.113.9\n");
      }

      if (!url.startsWith(ATLAS_API_PREFIX)) {
        return new Response(`unexpected URL: ${url}`, { status: 500 });
      }

      const authorization = new Headers(init.headers).get("authorization");
      if (!authorization) {
        return new Response("", {
          status: 401,
          headers: {
            "www-authenticate":
              'Digest realm="MMS Public API", nonce="abc123", algorithm=MD5, qop="auth"',
          },
        });
      }

      authenticatedRequests.push({ url, init });
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/mcpConfigs")) {
        const body = JSON.parse(String(init.body)) as {
          mcpConfigName: string;
          roles: string[];
          ipAccessList: Array<{ ipAddress: string }>;
        };
        return Response.json({
          mcpConfigId: `config-${body.mcpConfigName}`,
          mcpConfigName: body.mcpConfigName,
          clientId: `client-${body.mcpConfigName}`,
        });
      }
      if (pathname.endsWith("/secrets")) {
        return Response.json({ secret: "one-time-secret" });
      }
      return new Response(`unexpected Atlas path: ${pathname}`, { status: 500 });
    },
  );

  return { fetch, authenticatedRequests };
}

function options(
  fetch: typeof globalThis.fetch,
  uuid: string,
): AtlasMcpBootstrapOptions {
  return {
    env: atlasEnv(),
    fetch,
    randomUUID: () => uuid,
  };
}

describe("bootstrapAtlasMcp", () => {
  it("rejects missing Atlas-prefixed Admin API secrets", async () => {
    await expect(
      bootstrapAtlasMcp({
        env: {},
        fetch: vi.fn(),
        randomUUID: () => "unused",
      }),
    ).rejects.toThrow(
      "Missing Atlas Admin API env: ATLAS_ORG_ID, ATLAS_PUBLIC_API_KEY, ATLAS_PRIVATE_API_KEY",
    );
  });

  it("creates a unique ORG_OWNER MCP identity for the current egress IPv4", async () => {
    const { fetch, authenticatedRequests } = makeFetch();

    const credentials = await bootstrapAtlasMcp(
      options(fetch as typeof globalThis.fetch, "startup-a"),
    );

    expect(credentials).toEqual({
      orgId: "atlas-org-1",
      mcpConfigId: "config-atlas-explorer-startup-a",
      mcpConfigName: "atlas-explorer-startup-a",
      clientId: "client-atlas-explorer-startup-a",
      clientSecret: "one-time-secret",
    });

    const createConfig = authenticatedRequests.find(({ url }) =>
      new URL(url).pathname.endsWith("/mcpConfigs"),
    );
    expect(JSON.parse(String(createConfig?.init.body))).toEqual({
      mcpConfigName: "atlas-explorer-startup-a",
      roles: ["ORG_OWNER"],
      ipAccessList: [{ ipAddress: "203.0.113.9" }],
    });
    expect(
      new Headers(createConfig?.init.headers).get("authorization"),
    ).toMatch(
      /^Digest username="public-key".*realm="MMS Public API".*nonce="abc123"/,
    );
  });

  it("uses a fresh config name for each startup invocation", async () => {
    const first = makeFetch();
    const second = makeFetch();

    const firstCredentials = await bootstrapAtlasMcp(
      options(first.fetch as typeof globalThis.fetch, "startup-a"),
    );
    const secondCredentials = await bootstrapAtlasMcp(
      options(second.fetch as typeof globalThis.fetch, "startup-b"),
    );

    expect(firstCredentials.mcpConfigName).toBe("atlas-explorer-startup-a");
    expect(secondCredentials.mcpConfigName).toBe("atlas-explorer-startup-b");
  });
});
