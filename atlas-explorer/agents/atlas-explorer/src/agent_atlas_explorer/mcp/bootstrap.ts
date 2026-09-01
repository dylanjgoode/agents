import { createHash, randomBytes, randomUUID } from "node:crypto";

const ATLAS_API_BASE = "https://cloud.mongodb.com/api/atlas/v2";
const ATLAS_API_ACCEPT = "application/vnd.atlas.2025-03-12+json";
const SECRET_EXPIRES_AFTER_HOURS = 8760;
const PUBLIC_IP_URLS = [
  "https://api4.ipify.org",
  "https://ifconfig.me/ip",
  "https://icanhazip.com",
] as const;

export const MCP_CONFIG_NAME_PREFIX = "atlas-explorer";

export interface AtlasMcpCredentials {
  orgId: string;
  mcpConfigId: string;
  mcpConfigName: string;
  clientId: string;
  clientSecret: string;
}

export interface AtlasMcpBootstrapOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  randomUUID?: () => string;
}

interface AtlasAdminCredentials {
  orgId: string;
  publicApiKey: string;
  privateApiKey: string;
}

interface OrgMcpConfig {
  mcpConfigId?: string;
  mcpConfigName?: string | null;
  clientId?: string;
}

/**
 * Create a new Atlas Managed MCP identity for one Magenta runtime process.
 *
 * Atlas returns the client secret once. It is intentionally kept in memory
 * instead of being written into the application bundle or deployed filesystem.
 */
export async function bootstrapAtlasMcp(
  options: AtlasMcpBootstrapOptions = {},
): Promise<AtlasMcpCredentials> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const uuid = (options.randomUUID ?? randomUUID)();
  const admin = readAtlasAdminCredentials(env);
  const publicIp = await resolvePublicIpv4(fetchImpl);
  const mcpConfigName = `${MCP_CONFIG_NAME_PREFIX}-${uuid}`;

  const config = await createOrgMcpConfig(
    admin,
    mcpConfigName,
    publicIp,
    fetchImpl,
  );
  const mcpConfigId = requiredResponseField(config, "mcpConfigId");
  const clientId = requiredResponseField(config, "clientId");
  const clientSecret = await createOrgMcpSecret(
    admin,
    mcpConfigId,
    fetchImpl,
  );

  return {
    orgId: admin.orgId,
    mcpConfigId,
    mcpConfigName: config.mcpConfigName || mcpConfigName,
    clientId,
    clientSecret,
  };
}

function readAtlasAdminCredentials(
  env: NodeJS.ProcessEnv,
): AtlasAdminCredentials {
  const names = [
    "ATLAS_ORG_ID",
    "ATLAS_PUBLIC_API_KEY",
    "ATLAS_PRIVATE_API_KEY",
  ] as const;
  const missing = names.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing Atlas Admin API env: ${missing.join(", ")}`);
  }

  return {
    orgId: env.ATLAS_ORG_ID!.trim(),
    publicApiKey: env.ATLAS_PUBLIC_API_KEY!.trim(),
    privateApiKey: env.ATLAS_PRIVATE_API_KEY!.trim(),
  };
}

async function resolvePublicIpv4(
  fetchImpl: typeof globalThis.fetch,
): Promise<string> {
  const failures: string[] = [];
  for (const url of PUBLIC_IP_URLS) {
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: "text/plain" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        failures.push(`${url} returned HTTP ${response.status}`);
        continue;
      }
      const candidate = (await response.text()).trim();
      if (isIpv4Address(candidate)) return candidate;
      failures.push(`${url} returned a non-IPv4 response`);
    } catch (error) {
      failures.push(
        `${url} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  throw new Error(`Could not resolve public IPv4 (${failures.join("; ")})`);
}

function isIpv4Address(value: string): boolean {
  return /^((25[0-5]|(2[0-4]|1\d|[1-9]|)\d)(\.(?!$)|$)){4}$/.test(
    value,
  );
}

async function createOrgMcpConfig(
  admin: AtlasAdminCredentials,
  mcpConfigName: string,
  publicIp: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<OrgMcpConfig> {
  return atlasRequest<OrgMcpConfig>(
    admin,
    `/orgs/${encodeURIComponent(admin.orgId)}/mcpConfigs`,
    {
      method: "POST",
      body: JSON.stringify({
        mcpConfigName,
        roles: ["ORG_OWNER"],
        ipAccessList: [{ ipAddress: publicIp }],
      }),
    },
    fetchImpl,
  );
}

async function createOrgMcpSecret(
  admin: AtlasAdminCredentials,
  mcpConfigId: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<string> {
  const result = await atlasRequest<{ secret?: string }>(
    admin,
    `/orgs/${encodeURIComponent(admin.orgId)}/mcpConfigs/${encodeURIComponent(mcpConfigId)}/secrets`,
    {
      method: "POST",
      body: JSON.stringify({
        secretExpiresAfterHours: SECRET_EXPIRES_AFTER_HOURS,
      }),
    },
    fetchImpl,
  );

  if (!result.secret) {
    throw new Error(
      "Atlas MCP secret creation did not return its one-time secret",
    );
  }
  return result.secret;
}

async function atlasRequest<T>(
  admin: AtlasAdminCredentials,
  apiPath: string,
  init: { method: string; body?: string },
  fetchImpl: typeof globalThis.fetch,
): Promise<T> {
  const response = await digestFetch(
    `${ATLAS_API_BASE}${apiPath}`,
    {
      method: init.method,
      username: admin.publicApiKey,
      password: admin.privateApiKey,
      headers: {
        Accept: ATLAS_API_ACCEPT,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body,
    },
    fetchImpl,
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(formatAtlasError(response.status, text));
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

async function digestFetch(
  url: string,
  options: RequestInit & { username: string; password: string },
  fetchImpl: typeof globalThis.fetch,
): Promise<Response> {
  const { username, password, ...init } = options;
  const challengeResponse = await fetchImpl(url, init);
  const wwwAuthenticate = challengeResponse.headers.get("www-authenticate");
  if (
    challengeResponse.status !== 401 ||
    !wwwAuthenticate?.toLowerCase().startsWith("digest")
  ) {
    return challengeResponse;
  }
  await challengeResponse.body?.cancel().catch(() => undefined);

  const challenge = parseDigestChallenge(wwwAuthenticate);
  if (!challenge.nonce) {
    throw new Error("Atlas Admin API returned an invalid Digest challenge");
  }
  const parsedUrl = new URL(url);
  const uri = `${parsedUrl.pathname}${parsedUrl.search}`;
  const method = (init.method ?? "GET").toUpperCase();
  const nonceCount = "00000001";
  const clientNonce = randomBytes(8).toString("hex");
  const qualityOfProtection = challenge.qop?.split(",")[0]?.trim();
  const algorithm = (challenge.algorithm ?? "MD5").toUpperCase();
  const hash = digestHash(algorithm);

  let ha1 = hash(`${username}:${challenge.realm ?? ""}:${password}`);
  if (algorithm.endsWith("-SESS")) {
    ha1 = hash(`${ha1}:${challenge.nonce}:${clientNonce}`);
  }
  const ha2 = hash(`${method}:${uri}`);
  const responseDigest = qualityOfProtection
    ? hash(
        `${ha1}:${challenge.nonce}:${nonceCount}:${clientNonce}:${qualityOfProtection}:${ha2}`,
      )
    : hash(`${ha1}:${challenge.nonce}:${ha2}`);

  const authorization = [
    `username="${username}"`,
    `realm="${challenge.realm ?? ""}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
    `algorithm=${algorithm}`,
    `response="${responseDigest}"`,
  ];
  if (qualityOfProtection) {
    authorization.push(
      `qop=${qualityOfProtection}`,
      `nc=${nonceCount}`,
      `cnonce="${clientNonce}"`,
    );
  }
  if (challenge.opaque) {
    authorization.push(`opaque="${challenge.opaque}"`);
  }

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Digest ${authorization.join(", ")}`);
  return fetchImpl(url, { ...init, headers });
}

function parseDigestChallenge(header: string): Record<string, string> {
  const values: Record<string, string> = {};
  const body = header.replace(/^Digest\s+/i, "");
  const pattern =
    /([a-zA-Z][\w-]*)=(?:"((?:\\.|[^"])*)"|([^,\s]+))/g;
  for (const match of body.matchAll(pattern)) {
    values[match[1]] = (match[2] ?? match[3]).replace(/\\"/g, '"');
  }
  return values;
}

function digestHash(algorithm: string): (value: string) => string {
  const base = algorithm.replace(/-SESS$/i, "").toUpperCase();
  const nodeAlgorithm =
    base === "SHA-512-256"
      ? "sha512-256"
      : base === "SHA-256"
        ? "sha256"
        : "md5";
  return (value: string) =>
    createHash(nodeAlgorithm).update(value).digest("hex");
}

function formatAtlasError(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      errorCode?: string;
      reason?: string;
      detail?: string;
    };
    return [
      `Atlas Admin API ${status}`,
      parsed.errorCode,
      parsed.reason,
      parsed.detail,
    ]
      .filter(Boolean)
      .join(": ");
  } catch {
    return `Atlas Admin API ${status}: ${body.slice(0, 500)}`;
  }
}

function requiredResponseField(
  config: OrgMcpConfig,
  field: "mcpConfigId" | "clientId",
): string {
  const value = config[field];
  if (!value) {
    throw new Error(`Atlas MCP config response is missing ${field}`);
  }
  return value;
}
