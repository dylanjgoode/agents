# Incident: Atlas MCP service-account secret limit

Local notes on a bootstrap failure we hit while bringing up the Data Explorer agent against Atlas Managed MCP.

## What we saw

After Atlas auth and IP allowlisting were working, `pnpm langgraph` failed during MCP bootstrap with:

```text
Atlas Admin API 400: MAX_SECRETS_PER_SERVICE_ACCOUNT_EXCEEDED
Service Account secret limit (2) reached.
```

The stack pointed at `createOrgMcpSecret` in `packages/agent/src/mcp/bootstrap.ts`. The graph never finished loading.

Atlas allows **two** secrets per MCP service account. Secrets are returned **once** at create time; the plaintext lives only in the local cache file (`packages/agent/.mcp-credentials.json`, gitignored). Atlas keeps metadata (id, created/expiry/last-used, masked value) remotely.

## Sequence

1. Bootstrap created an org MCP config (default name `mongodb-agent-template`) and a client secret, then wrote the one-time secret to `.mcp-credentials.json`.
2. We deleted that file to force a “clean” re-bootstrap (we were debugging a separate Managed MCP **403** where the allowlisted address did not match the IPv4 address MCP actually saw).
3. Deleting the file did **not** delete the remote secret. Atlas still had it.
4. Bootstrap **reused** the existing org MCP config named `mongodb-agent-template` (the default in `getMcpConfigName()` / `DEFAULT_MCP_CONFIG_NAME`; override with env `MCP_CONFIG_NAME`). Reuse-by-name is correct.
5. Because the local cache was gone, it treated that as “we have a config but no secret” and **created another secret** on the same service account (incorrect — Atlas still had the old one-time secret).
6. A later retry created yet another, or left two secrets on the account. The next create hit the two-secret cap. The **config** is one named resource; the **secrets** are extra credentials hanging off its service account. Hitting the cap does not mean we created two configs.

So the limit error was a consequence of losing the local one-time secret while remote secrets remained, plus bootstrap creating secrets without checking remote metadata first.

## Recovery (what we did)

1. Listed secret **metadata** for the org MCP config via Atlas Admin API / Atlas CLI (`listOrgMcpSecrets`). That returns ids and timestamps, not the plaintext secret.
2. Confirmed both remote secrets were unusable by this app (local plaintext was gone).
3. Deleted those secrets by `secretId` (`deleteOrgMcpSecret`).
4. Verified the config had **zero** secrets.
5. Reran `pnpm langgraph` so bootstrap could create **one** new secret and persist it locally.

Do not delete `.mcp-credentials.json` as a routine fix. If you must, recover via Atlas (list → revoke unused secrets → bootstrap again). Revoking a secret that another client still uses will break that client immediately.

## Code change afterward

Bootstrap now (default path):

- Mints a **new** org MCP config named `mongodb-agent-template-<uuid>` per agent session, so each instance has its own revocable secret. It does **not** reuse the shared name `mongodb-agent-template`.
- Reuses local credentials when they still match *this instance’s* remote config.
- Optional `MCP_CONFIG_NAME` pins a shared config. That path lists remote secrets before creating and **throws** if unmatched secrets exist (with list/delete CLI), instead of hitting the two-secret cap.
- Never auto-revokes secrets.

See `bootstrapAtlasMcp` in `packages/agent/src/mcp/bootstrap.ts`.

## Related (not the same bug)

Earlier the same session, MCP HTTP returned `IP_ADDRESS_NOT_ON_ACCESS_LIST`. That was dual-stack: IP lookup returned IPv6 while Managed MCP observed IPv4. Bootstrap now prefers IPv4-only lookup and checks that the PATCH actually added the current address. That 403 is independent of the two-secret limit; deleting the credentials file while chasing it is what led into this incident.

## Takeaway

Treat `.mcp-credentials.json` as the only copy of *this instance’s* MCP client secret. Losing it does not reset Atlas; default bootstrap now creates a **new** named config instead of stacking secrets on the old one. For a pinned `MCP_CONFIG_NAME`, inspect remote secret metadata, revoke only what you intend, then bootstrap again.
