import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../env.js";

const ATLAS_API_BASE = "https://cloud.mongodb.com/api/atlas/v2";
const ATLAS_API_ACCEPT = "application/vnd.atlas.2025-03-12+json";
/** Prefix for per-session config names. Do not reuse this string as a shared org-wide config. */
export const MCP_CONFIG_NAME_PREFIX = "mongodb-agent-template";
const SECRET_EXPIRES_AFTER_HOURS = 8760;
const ORG_MCP_ROLES = ["ORG_OWNER"] as const;
const PUBLIC_IP_URLS = [
  "https://api4.ipify.org",
  "https://ifconfig.me/ip",
  "https://icanhazip.com",
];

const CREDENTIALS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.mcp-credentials.json",
);

export type McpCredentials = {
  orgId: string;
  mcpConfigId: string;
  mcpConfigName: string;
  clientId: string;
  clientSecret: string;
};

type IpAccessListEntry = {
  cidrBlock?: string | null;
  ipAddress?: string | null;
};

type OrgMcpConfig = {
  mcpConfigId: string;
  mcpConfigName: string | null;
  clientId: string;
  ipAccessList?: IpAccessListEntry[];
  roles?: string[];
};

type OrgMcpSecretMetadata = {
  id: string;
  createdAt?: string;
  expiresAt?: string;
  lastUsedAt?: string | null;
  maskedSecretValue?: string;
};

type Paginated<T> = {
  results?: T[];
  totalCount?: number;
};

export function getMcpCredentialsPath(): string {
  return CREDENTIALS_PATH;
}

/** Pinned name from `MCP_CONFIG_NAME`, or undefined to mint a per-session config. */
export function getPinnedMcpConfigName(): string | undefined {
  const pinned = process.env.MCP_CONFIG_NAME?.trim();
  return pinned || undefined;
}

/** @deprecated Prefer `getPinnedMcpConfigName` or `newSessionMcpConfigName`. */
export function getMcpConfigName(): string {
  return getPinnedMcpConfigName() ?? MCP_CONFIG_NAME_PREFIX;
}

/** Unique org MCP config name so each agent instance has its own revocable secret. */
export function newSessionMcpConfigName(): string {
  return `${MCP_CONFIG_NAME_PREFIX}-${randomUUID()}`;
}

/**
 * Bind this agent instance to an org MCP config and one-time secret.
 *
 * Default: new unique config name per session (`mongodb-agent-template-<uuid>`).
 * Reuse only this instance's local cache (same process restarts). Do not share
 * one org-wide name — that makes instances share a service account / secret cap.
 *
 * Pin with `MCP_CONFIG_NAME` when you explicitly want a shared/stable config
 * (still refuses to mint a second secret if remote secrets already exist).
 */
export async function bootstrapAtlasMcp(): Promise<McpCredentials> {
  const orgId = requireAtlasEnv();
  const publicIp = await resolvePublicIp();
  const local = loadLocalCredentials();

  if (local && local.orgId === orgId && local.clientSecret) {
    const existing = await getOrgMcpConfig(orgId, local.mcpConfigId);
    if (existing && existing.clientId === local.clientId) {
      await ensureCurrentIpAllowlisted(orgId, existing, publicIp);
      return local;
    }
  }

  const pinned = getPinnedMcpConfigName();
  if (pinned) {
    return bootstrapPinnedConfig(orgId, publicIp, pinned, local);
  }

  const configName = newSessionMcpConfigName();
  const created = await createOrgMcpConfig(orgId, configName, publicIp);
  const secret = await createOrgMcpSecret(orgId, created);
  return persistCredentials({
    orgId,
    mcpConfigId: created.mcpConfigId,
    mcpConfigName: created.mcpConfigName ?? configName,
    clientId: created.clientId,
    clientSecret: secret,
  });
}

async function bootstrapPinnedConfig(
  orgId: string,
  publicIp: string,
  configName: string,
  local: McpCredentials | undefined,
): Promise<McpCredentials> {
  const byName = await findOrgMcpConfigByName(orgId, configName);
  if (byName) {
    await ensureCurrentIpAllowlisted(orgId, byName, publicIp);
    if (
      local &&
      local.orgId === orgId &&
      local.mcpConfigId === byName.mcpConfigId &&
      local.clientId === byName.clientId &&
      local.clientSecret
    ) {
      return local;
    }
    const secrets = await listOrgMcpSecrets(orgId, byName.mcpConfigId);
    if (secrets.length > 0) {
      throw new Error(formatSecretRecoveryError(orgId, byName, secrets.length));
    }
    const secret = await createOrgMcpSecret(orgId, byName);
    return persistCredentials({
      orgId,
      mcpConfigId: byName.mcpConfigId,
      mcpConfigName: byName.mcpConfigName ?? configName,
      clientId: byName.clientId,
      clientSecret: secret,
    });
  }

  const created = await createOrgMcpConfig(orgId, configName, publicIp);
  const secret = await createOrgMcpSecret(orgId, created);
  return persistCredentials({
    orgId,
    mcpConfigId: created.mcpConfigId,
    mcpConfigName: created.mcpConfigName ?? configName,
    clientId: created.clientId,
    clientSecret: secret,
  });
}

export const ensureOrgMcpCredentials = bootstrapAtlasMcp;

function requireAtlasEnv(): string {
  const missing = (
    ["ORG_ID", "PUBLIC_API_KEY", "PRIVATE_API_KEY"] as const
  ).filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing Atlas Admin API env: ${missing.join(", ")}. Set programmatic API keys, not MCP client credentials.`,
    );
  }
  return env.ORG_ID;
}

function loadLocalCredentials(): McpCredentials | undefined {
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<McpCredentials>;
    if (
      parsed.orgId &&
      parsed.mcpConfigId &&
      parsed.mcpConfigName &&
      parsed.clientId &&
      parsed.clientSecret
    ) {
      return parsed as McpCredentials;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return undefined;
}

function persistCredentials(credentials: McpCredentials): McpCredentials {
  fs.writeFileSync(
    CREDENTIALS_PATH,
    `${JSON.stringify(credentials, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  fs.chmodSync(CREDENTIALS_PATH, 0o600);
  return credentials;
}

async function resolvePublicIp(): Promise<string> {
  const errors: string[] = [];
  for (const url of PUBLIC_IP_URLS) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "text/plain" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        errors.push(`${url} → HTTP ${response.status}`);
        continue;
      }
      const ip = (await response.text()).trim();
      if (isIpv4Address(ip)) {
        return ip;
      }
      errors.push(`${url} → unexpected body`);
    } catch (error) {
      errors.push(`${url} → ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Could not resolve public IP (${errors.join("; ")})`);
}

function isIpv4Address(value: string): boolean {
  return /^((25[0-5]|(2[0-4]|1\d|[1-9]|)\d)(\.(?!$)|$)){4}$/.test(
    value,
  );
}

async function getOrgMcpConfig(
  orgId: string,
  mcpConfigId: string,
): Promise<OrgMcpConfig | undefined> {
  const response = await atlasRequest(
    `/orgs/${orgId}/mcpConfigs/${encodeURIComponent(mcpConfigId)}`,
    { method: "GET" },
  );
  if (response.status === 404) {
    return undefined;
  }
  return parseAtlasJson<OrgMcpConfig>(response);
}

async function findOrgMcpConfigByName(
  orgId: string,
  name: string,
): Promise<OrgMcpConfig | undefined> {
  const itemsPerPage = 100;
  for (let pageNum = 1; ; pageNum += 1) {
    const query = new URLSearchParams({
      itemsPerPage: String(itemsPerPage),
      pageNum: String(pageNum),
    });
    const response = await atlasRequest(
      `/orgs/${orgId}/mcpConfigs?${query.toString()}`,
      { method: "GET" },
    );
    const page = await parseAtlasJson<Paginated<OrgMcpConfig>>(response);
    const match = (page.results ?? []).find(
      (config) => config.mcpConfigName === name,
    );
    if (match) {
      return match;
    }
    const received = pageNum * itemsPerPage;
    if (
      !page.results?.length ||
      page.results.length < itemsPerPage ||
      (page.totalCount !== undefined && received >= page.totalCount)
    ) {
      return undefined;
    }
  }
}

async function createOrgMcpConfig(
  orgId: string,
  mcpConfigName: string,
  publicIp: string,
): Promise<OrgMcpConfig> {
  const response = await atlasRequest(`/orgs/${orgId}/mcpConfigs`, {
    method: "POST",
    body: JSON.stringify({
      mcpConfigName,
      roles: [...ORG_MCP_ROLES],
      ipAccessList: [{ ipAddress: publicIp }],
    }),
  });
  return parseAtlasJson<OrgMcpConfig>(response);
}

async function listOrgMcpSecrets(
  orgId: string,
  mcpConfigId: string,
): Promise<OrgMcpSecretMetadata[]> {
  const response = await atlasRequest(
    `/orgs/${orgId}/mcpConfigs/${encodeURIComponent(mcpConfigId)}/secrets`,
    { method: "GET" },
  );
  const page = await parseAtlasJson<Paginated<OrgMcpSecretMetadata>>(response);
  return page.results ?? [];
}

async function createOrgMcpSecret(
  orgId: string,
  config: OrgMcpConfig,
): Promise<string> {
  let payload: { secret?: string };
  try {
    const response = await atlasRequest(
      `/orgs/${orgId}/mcpConfigs/${encodeURIComponent(config.mcpConfigId)}/secrets`,
      {
        method: "POST",
        body: JSON.stringify({
          secretExpiresAfterHours: SECRET_EXPIRES_AFTER_HOURS,
        }),
      },
    );
    payload = await parseAtlasJson<{ secret?: string }>(response);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("MAX_SECRETS_PER_SERVICE_ACCOUNT_EXCEEDED")
    ) {
      throw new Error(
        `${error.message}. ${formatSecretRecoveryError(orgId, config, 2)}`,
        { cause: error },
      );
    }
    throw error;
  }
  if (!payload.secret) {
    throw new Error(
      "createOrgMcpSecret did not return a secret. Atlas returns the value only once.",
    );
  }
  return payload.secret;
}

function formatSecretRecoveryError(
  orgId: string,
  config: OrgMcpConfig,
  secretCount: number,
): string {
  const name = config.mcpConfigName ?? "<unnamed>";
  const listCommand =
    "atlas api remoteMcpConfigurations listOrgMcpSecrets" +
    ` --version 2025-03-12 --orgId ${orgId}` +
    ` --mcpConfigId ${config.mcpConfigId}`;
  const deleteCommand =
    "atlas api remoteMcpConfigurations deleteOrgMcpSecret" +
    ` --version 2025-03-12 --orgId ${orgId}` +
    ` --mcpConfigId ${config.mcpConfigId}` +
    " --secretId <selected-secret-id>";
  const state =
    secretCount >= 2
      ? "Service Account secret limit (2) reached"
      : `Found ${secretCount} existing remote secret`;
  return (
    `${state} for remote MCP config ` +
    `"${name}" (mcpConfigId=${config.mcpConfigId}, clientId=${config.clientId}). ` +
    "The local one-time client secret is unavailable, and Atlas secret metadata " +
    "cannot identify which existing secret this bootstrap previously created. " +
    `Review nonsecret metadata with \`${listCommand}\`, explicitly select an unused ` +
    `secret, revoke only that secret with \`${deleteCommand}\`, then rerun bootstrap.`
  );
}

async function ensureCurrentIpAllowlisted(
  orgId: string,
  config: OrgMcpConfig,
  publicIp: string,
): Promise<void> {
  if (ipAccessListIncludes(config.ipAccessList ?? [], publicIp)) {
    return;
  }
  const merged = [
    ...toWritableIpAccessList(config.ipAccessList ?? []),
    { ipAddress: publicIp },
  ];
  console.info(
    `[Atlas MCP] Reconciling config ${config.mcpConfigName ?? "<unnamed>"} (${config.mcpConfigId}) with ipAddress=${publicIp}`,
  );
  const response = await atlasRequest(
    `/orgs/${orgId}/mcpConfigs/${encodeURIComponent(config.mcpConfigId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ ipAccessList: merged }),
    },
  );
  const updated = await parseAtlasJson<OrgMcpConfig>(response);
  if (!ipAccessListIncludes(updated.ipAccessList ?? [], publicIp)) {
    throw new Error(
      `Atlas MCP config ${config.mcpConfigName ?? "<unnamed>"} (${config.mcpConfigId}) update did not include ${publicIp} in ipAccessList`,
    );
  }
}

function ipAccessListIncludes(
  entries: IpAccessListEntry[],
  ip: string,
): boolean {
  return entries.some(
    (entry) => entry.ipAddress === ip || entry.cidrBlock === `${ip}/32`,
  );
}

function toWritableIpAccessList(
  entries: IpAccessListEntry[],
): Array<{ ipAddress: string } | { cidrBlock: string }> {
  const result: Array<{ ipAddress: string } | { cidrBlock: string }> = [];
  for (const entry of entries) {
    if (entry.ipAddress) {
      result.push({ ipAddress: entry.ipAddress });
    } else if (entry.cidrBlock) {
      result.push({ cidrBlock: entry.cidrBlock });
    }
  }
  return result;
}

async function atlasRequest(
  apiPath: string,
  init: { method: string; body?: string },
): Promise<Response> {
  return digestFetch(`${ATLAS_API_BASE}${apiPath}`, {
    method: init.method,
    username: env.PUBLIC_API_KEY,
    password: env.PRIVATE_API_KEY,
    headers: {
      Accept: ATLAS_API_ACCEPT,
      ...(init.body
        ? { "Content-Type": "application/json" }
        : {}),
    },
    body: init.body,
  });
}

async function parseAtlasJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(formatAtlasError(response.status, text));
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

function formatAtlasError(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      errorCode?: string;
      reason?: string;
      detail?: string;
    };
    const parts = [
      `Atlas Admin API ${status}`,
      parsed.errorCode,
      parsed.reason,
      parsed.detail,
    ].filter(Boolean);
    return parts.join(": ");
  } catch {
    return `Atlas Admin API ${status}: ${body.slice(0, 500)}`;
  }
}

async function digestFetch(
  url: string,
  options: RequestInit & { username: string; password: string },
): Promise<Response> {
  const { username, password, ...init } = options;
  const first = await fetch(url, init);
  const wwwAuth = first.headers.get("www-authenticate");
  if (first.status !== 401 || !wwwAuth?.toLowerCase().startsWith("digest")) {
    return first;
  }
  await first.body?.cancel().catch(() => undefined);

  const challenge = parseDigestChallenge(wwwAuth);
  const uri = new URL(url).pathname + new URL(url).search;
  const method = (init.method ?? "GET").toUpperCase();
  const nc = "00000001";
  const cnonce = randomBytes(8).toString("hex");
  const qop = challenge.qop?.split(",")[0]?.trim();
  const algorithm = (challenge.algorithm ?? "MD5").toUpperCase();
  const hash = hashForDigest(algorithm);

  let ha1 = hash(`${username}:${challenge.realm ?? ""}:${password}`);
  if (algorithm.endsWith("-SESS")) {
    ha1 = hash(`${ha1}:${challenge.nonce}:${cnonce}`);
  }
  const ha2 = hash(`${method}:${uri}`);
  const responseDigest = qop
    ? hash(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : hash(`${ha1}:${challenge.nonce}:${ha2}`);

  const parts = [
    `username="${username}"`,
    `realm="${challenge.realm ?? ""}"`,
    `nonce="${challenge.nonce ?? ""}"`,
    `uri="${uri}"`,
    `algorithm=${algorithm}`,
    `response="${responseDigest}"`,
  ];
  if (qop) {
    parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  }
  if (challenge.opaque) {
    parts.push(`opaque="${challenge.opaque}"`);
  }

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Digest ${parts.join(", ")}`);
  return fetch(url, { ...init, headers });
}

function parseDigestChallenge(header: string): Record<string, string> {
  const params: Record<string, string> = {};
  const body = header.replace(/^Digest\s+/i, "");
  const re =
    /([a-zA-Z][\w-]*)=(?:"((?:\\.|[^"])*)"|([^,\s]+))/g;
  for (const match of body.matchAll(re)) {
    params[match[1]] = (match[2] ?? match[3]).replace(/\\"/g, '"');
  }
  return params;
}

function hashForDigest(algorithm: string): (value: string) => string {
  const base = algorithm.replace(/-SESS$/i, "").toUpperCase();
  const nodeAlg =
    base === "SHA-512-256"
      ? "sha512-256"
      : base === "SHA-256"
        ? "sha256"
        : "md5";
  return (value: string) => createHash(nodeAlg).update(value).digest("hex");
}
