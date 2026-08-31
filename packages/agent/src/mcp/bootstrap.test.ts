import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const atlasEnv = vi.hoisted(() => ({
  ORG_ID: "org-1",
  PUBLIC_API_KEY: "pub-key",
  PRIVATE_API_KEY: "priv-key",
}));

vi.mock("../env.js", () => ({
  env: atlasEnv,
}));

import {
  bootstrapAtlasMcp,
  ensureOrgMcpCredentials,
  getMcpConfigName,
  getMcpCredentialsPath,
  getPinnedMcpConfigName,
  MCP_CONFIG_NAME_PREFIX,
  newSessionMcpConfigName,
} from "./bootstrap.js";

const CREDENTIALS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.mcp-credentials.json",
);

const ATLAS_PREFIX = "https://cloud.mongodb.com/api/atlas/v2";

type AtlasHandler = (url: string, init: RequestInit) => Response;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetchMock(
  atlas: AtlasHandler,
  publicIps: Record<string, string> = {
    "ifconfig.me": "203.0.113.9",
    "icanhazip.com": "203.0.113.9",
  },
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    const publicIp = Object.entries(publicIps).find(([host]) =>
      url.includes(host),
    )?.[1];
    if (publicIp) {
      return new Response(`${publicIp}\n`, { status: 200 });
    }

    if (url.startsWith(ATLAS_PREFIX)) {
      const headers = new Headers(init?.headers);
      const authorization = headers.get("authorization") ?? "";
      if (!authorization.toLowerCase().startsWith("digest ")) {
        return new Response("", {
          status: 401,
          headers: {
            "www-authenticate":
              'Digest realm="MMS Public API", nonce="abc123", algorithm=MD5, qop="auth"',
          },
        });
      }
      return atlas(url, init ?? {});
    }

    return new Response(`unmocked ${url}`, { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("MCP bootstrap helpers", () => {
  it("getMcpCredentialsPath points at the package credentials file", () => {
    expect(getMcpCredentialsPath()).toBe(CREDENTIALS_PATH);
  });

  it("getPinnedMcpConfigName is unset by default and honors MCP_CONFIG_NAME", () => {
    const previous = process.env.MCP_CONFIG_NAME;
    delete process.env.MCP_CONFIG_NAME;
    expect(getPinnedMcpConfigName()).toBeUndefined();
    expect(getMcpConfigName()).toBe(MCP_CONFIG_NAME_PREFIX);
    process.env.MCP_CONFIG_NAME = "  custom-config  ";
    expect(getPinnedMcpConfigName()).toBe("custom-config");
    expect(getMcpConfigName()).toBe("custom-config");
    if (previous === undefined) {
      delete process.env.MCP_CONFIG_NAME;
    } else {
      process.env.MCP_CONFIG_NAME = previous;
    }
  });

  it("newSessionMcpConfigName is unique per call", () => {
    const a = newSessionMcpConfigName();
    const b = newSessionMcpConfigName();
    expect(a).toMatch(
      new RegExp(`^${MCP_CONFIG_NAME_PREFIX}-[0-9a-f-]{36}$`, "i"),
    );
    expect(a).not.toBe(b);
  });
});

describe("bootstrapAtlasMcp", () => {
  const originalReadFileSync = fs.readFileSync.bind(fs);
  const originalWriteFileSync = fs.writeFileSync.bind(fs);
  const originalChmodSync = fs.chmodSync.bind(fs);
  let credsOnDisk: string | undefined;

  beforeEach(() => {
    credsOnDisk = undefined;
    atlasEnv.ORG_ID = "org-1";
    atlasEnv.PUBLIC_API_KEY = "pub-key";
    atlasEnv.PRIVATE_API_KEY = "priv-key";
    delete process.env.MCP_CONFIG_NAME;

    vi.spyOn(fs, "readFileSync").mockImplementation(((
      p: fs.PathOrFileDescriptor,
      options?: fs.WriteFileOptions,
    ) => {
      if (path.resolve(String(p)) === CREDENTIALS_PATH) {
        if (credsOnDisk === undefined) {
          const err = new Error("ENOENT") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        }
        return credsOnDisk;
      }
      return originalReadFileSync(p, options as BufferEncoding);
    }) as typeof fs.readFileSync);

    vi.spyOn(fs, "writeFileSync").mockImplementation(((
      p: fs.PathOrFileDescriptor,
      data: string | NodeJS.ArrayBufferView,
    ) => {
      if (path.resolve(String(p)) === CREDENTIALS_PATH) {
        credsOnDisk = String(data);
        return undefined;
      }
      return originalWriteFileSync(p, data);
    }) as typeof fs.writeFileSync);

    vi.spyOn(fs, "chmodSync").mockImplementation(((p: fs.PathLike, mode: fs.Mode) => {
      if (path.resolve(String(p)) === CREDENTIALS_PATH) {
        return undefined;
      }
      return originalChmodSync(p, mode);
    }) as typeof fs.chmodSync);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("throws when Atlas Admin API env is missing", async () => {
    atlasEnv.ORG_ID = "";
    atlasEnv.PUBLIC_API_KEY = "";
    atlasEnv.PRIVATE_API_KEY = "";

    await expect(bootstrapAtlasMcp()).rejects.toThrow(
      /Missing Atlas Admin API env: ORG_ID, PUBLIC_API_KEY, PRIVATE_API_KEY/,
    );
  });

  it("creates a unique org MCP config per session and persists the one-time secret", async () => {
    let createdName: string | undefined;
    installFetchMock((url, init) => {
      const method = (init.method ?? "GET").toUpperCase();
      if (method === "POST" && /\/mcpConfigs$/.test(new URL(url).pathname)) {
        const body = JSON.parse(String(init.body));
        expect(body.mcpConfigName).toMatch(
          new RegExp(`^${MCP_CONFIG_NAME_PREFIX}-[0-9a-f-]{36}$`, "i"),
        );
        expect(body.roles).toEqual(["ORG_OWNER"]);
        expect(body.ipAccessList).toEqual([{ ipAddress: "203.0.113.9" }]);
        createdName = body.mcpConfigName;
        return jsonResponse({
          mcpConfigId: "cfg-new",
          mcpConfigName: body.mcpConfigName,
          clientId: "client-new",
        });
      }
      if (method === "POST" && url.includes("/secrets")) {
        return jsonResponse({ secret: "one-time-secret" });
      }
      return jsonResponse({ detail: `unhandled ${method} ${url}` }, 500);
    });

    const creds = await bootstrapAtlasMcp();

    expect(createdName).toBeDefined();
    expect(creds).toEqual({
      orgId: "org-1",
      mcpConfigId: "cfg-new",
      mcpConfigName: createdName,
      clientId: "client-new",
      clientSecret: "one-time-secret",
    });
    expect(credsOnDisk).toContain("one-time-secret");
  });

  it("does not attach a new session to an existing shared-name config", async () => {
    const methods: string[] = [];
    installFetchMock((url, init) => {
      const method = (init.method ?? "GET").toUpperCase();
      methods.push(`${method} ${new URL(url).pathname}`);
      if (method === "GET" && url.includes("/mcpConfigs?")) {
        return jsonResponse({
          results: [
            {
              mcpConfigId: "cfg-shared",
              mcpConfigName: MCP_CONFIG_NAME_PREFIX,
              clientId: "client-shared",
              ipAccessList: [{ ipAddress: "203.0.113.9" }],
            },
          ],
          totalCount: 1,
        });
      }
      if (method === "POST" && /\/mcpConfigs$/.test(new URL(url).pathname)) {
        const body = JSON.parse(String(init.body));
        expect(body.mcpConfigName).not.toBe(MCP_CONFIG_NAME_PREFIX);
        return jsonResponse({
          mcpConfigId: "cfg-session",
          mcpConfigName: body.mcpConfigName,
          clientId: "client-session",
        });
      }
      if (method === "POST" && url.includes("/secrets")) {
        expect(url).toContain("cfg-session");
        return jsonResponse({ secret: "session-secret" });
      }
      return jsonResponse({ detail: `unhandled ${method} ${url}` }, 500);
    });

    const creds = await bootstrapAtlasMcp();
    expect(creds.mcpConfigId).toBe("cfg-session");
    expect(creds.clientSecret).toBe("session-secret");
    expect(methods.some((m) => m.includes("cfg-shared"))).toBe(false);
  });

  it("does not blindly create a secret when a pinned config already has unmatched remote secrets", async () => {
    process.env.MCP_CONFIG_NAME = "mongodb-agent-template";
    const methods: string[] = [];
    installFetchMock((url, init) => {
      const method = (init.method ?? "GET").toUpperCase();
      methods.push(`${method} ${new URL(url).pathname}`);
      if (method === "GET" && url.includes("/mcpConfigs?")) {
        return jsonResponse({
          results: [
            {
              mcpConfigId: "cfg-existing",
              mcpConfigName: "mongodb-agent-template",
              clientId: "client-existing",
              ipAccessList: [{ ipAddress: "203.0.113.9" }],
            },
          ],
          totalCount: 1,
        });
      }
      if (method === "GET" && url.endsWith("/mcpConfigs/cfg-existing/secrets")) {
        return jsonResponse({
          results: [{ id: "secret-existing", lastUsedAt: null }],
          totalCount: 1,
        });
      }
      return jsonResponse({ detail: `unhandled ${method} ${url}` }, 500);
    });

    await expect(bootstrapAtlasMcp()).rejects.toThrow(
      /found 1 existing remote secret.*mongodb-agent-template.*cfg-existing.*client-existing.*cannot identify which existing secret.*listOrgMcpSecrets.*deleteOrgMcpSecret/is,
    );
    expect(methods.some((method) => method.startsWith("POST"))).toBe(false);
  });

  it("fails before secret creation when a pinned config is at the two-secret limit", async () => {
    process.env.MCP_CONFIG_NAME = "mongodb-agent-template";
    const methods: string[] = [];
    installFetchMock((url, init) => {
      const method = (init.method ?? "GET").toUpperCase();
      methods.push(`${method} ${new URL(url).pathname}`);
      if (method === "GET" && url.includes("/mcpConfigs?")) {
        return jsonResponse({
          results: [
            {
              mcpConfigId: "cfg-existing",
              mcpConfigName: "mongodb-agent-template",
              clientId: "client-existing",
              ipAccessList: [{ ipAddress: "203.0.113.9" }],
            },
          ],
          totalCount: 1,
        });
      }
      if (method === "GET" && url.endsWith("/mcpConfigs/cfg-existing/secrets")) {
        return jsonResponse({
          results: [
            { id: "secret-1", lastUsedAt: "2026-08-20T00:00:00Z" },
            { id: "secret-2", lastUsedAt: null },
          ],
          totalCount: 2,
        });
      }
      return jsonResponse({ detail: `unhandled ${method} ${url}` }, 500);
    });

    await expect(bootstrapAtlasMcp()).rejects.toThrow(
      /secret limit \(2\) reached.*mongodb-agent-template.*cfg-existing.*client-existing.*listOrgMcpSecrets.*deleteOrgMcpSecret/is,
    );
    expect(methods.some((method) => method.startsWith("POST"))).toBe(false);
  });

  it("translates an Atlas secret-limit race into actionable recovery instructions for a pinned config", async () => {
    process.env.MCP_CONFIG_NAME = "mongodb-agent-template";
    installFetchMock((url, init) => {
      const method = (init.method ?? "GET").toUpperCase();
      if (method === "GET" && url.includes("/mcpConfigs?")) {
        return jsonResponse({
          results: [
            {
              mcpConfigId: "cfg-existing",
              mcpConfigName: "mongodb-agent-template",
              clientId: "client-existing",
              ipAccessList: [{ ipAddress: "203.0.113.9" }],
            },
          ],
          totalCount: 1,
        });
      }
      if (method === "GET" && url.endsWith("/mcpConfigs/cfg-existing/secrets")) {
        return jsonResponse({ results: [], totalCount: 0 });
      }
      if (method === "POST" && url.endsWith("/mcpConfigs/cfg-existing/secrets")) {
        return jsonResponse(
          {
            errorCode: "MAX_SECRETS_PER_SERVICE_ACCOUNT_EXCEEDED",
            reason: "Bad Request",
            detail: "Service Account secret limit (2) reached.",
          },
          400,
        );
      }
      return jsonResponse({ detail: `unhandled ${method} ${url}` }, 500);
    });

    await expect(bootstrapAtlasMcp()).rejects.toThrow(
      /MAX_SECRETS_PER_SERVICE_ACCOUNT_EXCEEDED.*mongodb-agent-template.*cfg-existing.*client-existing.*listOrgMcpSecrets.*deleteOrgMcpSecret/is,
    );
  });

  it("reuses local credentials when the remote config still matches", async () => {
    credsOnDisk = JSON.stringify({
      orgId: "org-1",
      mcpConfigId: "cfg-existing",
      mcpConfigName: "mongodb-agent-template",
      clientId: "client-existing",
      clientSecret: "stored-secret",
    });

    const methods: string[] = [];
    installFetchMock((url, init) => {
      const method = (init.method ?? "GET").toUpperCase();
      methods.push(`${method} ${new URL(url).pathname}`);
      if (method === "GET" && url.includes("/mcpConfigs/cfg-existing")) {
        return jsonResponse({
          mcpConfigId: "cfg-existing",
          mcpConfigName: "mongodb-agent-template",
          clientId: "client-existing",
          ipAccessList: [{ ipAddress: "203.0.113.9" }],
        });
      }
      return jsonResponse({ detail: `unhandled ${method} ${url}` }, 500);
    });

    const creds = await bootstrapAtlasMcp();

    expect(creds.clientSecret).toBe("stored-secret");
    expect(methods.some((m) => m.startsWith("POST"))).toBe(false);
  });

  it("PATCHes the IP allowlist when the current IP is missing", async () => {
    credsOnDisk = JSON.stringify({
      orgId: "org-1",
      mcpConfigId: "cfg-existing",
      mcpConfigName: "mongodb-agent-template",
      clientId: "client-existing",
      clientSecret: "stored-secret",
    });

    let patched = false;
    installFetchMock((url, init) => {
      const method = (init.method ?? "GET").toUpperCase();
      if (method === "GET" && url.includes("/mcpConfigs/cfg-existing")) {
        return jsonResponse({
          mcpConfigId: "cfg-existing",
          mcpConfigName: "mongodb-agent-template",
          clientId: "client-existing",
          ipAccessList: [{ ipAddress: "198.51.100.1" }],
        });
      }
      if (method === "PATCH" && url.includes("/mcpConfigs/cfg-existing")) {
        patched = true;
        const body = JSON.parse(String(init.body));
        expect(body.ipAccessList).toEqual(
          expect.arrayContaining([
            { ipAddress: "198.51.100.1" },
            { ipAddress: "203.0.113.9" },
          ]),
        );
        return jsonResponse({
          mcpConfigId: "cfg-existing",
          clientId: "client-existing",
          ipAccessList: body.ipAccessList,
        });
      }
      return jsonResponse({ detail: `unhandled ${method} ${url}` }, 500);
    });

    await bootstrapAtlasMcp();
    expect(patched).toBe(true);
  });

  it("allowlists the IPv4 egress used by Managed MCP on a dual-stack network", async () => {
    credsOnDisk = JSON.stringify({
      orgId: "org-1",
      mcpConfigId: "cfg-existing",
      mcpConfigName: "mongodb-agent-template",
      clientId: "client-existing",
      clientSecret: "stored-secret",
    });

    installFetchMock(
      (url, init) => {
        const method = (init.method ?? "GET").toUpperCase();
        if (method === "GET" && url.includes("/mcpConfigs/cfg-existing")) {
          return jsonResponse({
            mcpConfigId: "cfg-existing",
            mcpConfigName: "mongodb-agent-template",
            clientId: "client-existing",
            ipAccessList: [{ cidrBlock: "2a09:bac0:1000:2007::41a:47/128" }],
          });
        }
        if (method === "PATCH" && url.includes("/mcpConfigs/cfg-existing")) {
          const body = JSON.parse(String(init.body));
          expect(body.ipAccessList).toEqual(
            expect.arrayContaining([{ ipAddress: "104.30.164.7" }]),
          );
          return jsonResponse({
            mcpConfigId: "cfg-existing",
            mcpConfigName: "mongodb-agent-template",
            clientId: "client-existing",
            ipAccessList: body.ipAccessList,
          });
        }
        return jsonResponse({ detail: `unhandled ${method} ${url}` }, 500);
      },
      {
        "ifconfig.me": "2a09:bac0:1000:2007::41a:47",
        "icanhazip.com": "2a09:bac0:1000:2007::41a:47",
        "api4.ipify.org": "104.30.164.7",
      },
    );

    await bootstrapAtlasMcp();
  });

  it("fails bootstrap when Atlas does not return the reconciled allowlist entry", async () => {
    credsOnDisk = JSON.stringify({
      orgId: "org-1",
      mcpConfigId: "cfg-existing",
      mcpConfigName: "mongodb-agent-template",
      clientId: "client-existing",
      clientSecret: "stored-secret",
    });

    installFetchMock((url, init) => {
      const method = (init.method ?? "GET").toUpperCase();
      if (method === "GET" && url.includes("/mcpConfigs/cfg-existing")) {
        return jsonResponse({
          mcpConfigId: "cfg-existing",
          mcpConfigName: "mongodb-agent-template",
          clientId: "client-existing",
          ipAccessList: [],
        });
      }
      if (method === "PATCH" && url.includes("/mcpConfigs/cfg-existing")) {
        return jsonResponse({
          mcpConfigId: "cfg-existing",
          mcpConfigName: "mongodb-agent-template",
          clientId: "client-existing",
          ipAccessList: [],
        });
      }
      return jsonResponse({ detail: `unhandled ${method} ${url}` }, 500);
    });

    await expect(bootstrapAtlasMcp()).rejects.toThrow(
      /did not include 203\.0\.113\.9/,
    );
  });

  it("formats Atlas error payloads", async () => {
    installFetchMock(() =>
      jsonResponse(
        {
          errorCode: "NOT_FOUND",
          reason: "Not Found",
          detail: "no configs",
        },
        404,
      ),
    );

    await expect(bootstrapAtlasMcp()).rejects.toThrow(
      /Atlas Admin API 404: NOT_FOUND: Not Found: no configs/,
    );
  });

  it("is aliased as ensureOrgMcpCredentials", () => {
    expect(ensureOrgMcpCredentials).toBe(bootstrapAtlasMcp);
  });
});
