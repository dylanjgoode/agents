# Technical Design: MongoDB Data Explorer Agent

A TypeScript agent template for exploring and querying MongoDB databases hosted on Atlas. The repo is a **pnpm workspace**: `packages/agent` (Deep Agents / LangGraph graph) and `packages/frontend` (local chat UI). Package internals below are the intended shape of the template, not existing implementation.

The agent is a Deep Agents harness on LangGraph, not a thin MCP tool loop. Users bring Atlas credentials and an LLM key. Local chat is the first deployment target. Magenta (MongoDB’s agentic platform) is a later target and is not part of v0.

## Goals

- Let a user inspect Atlas orgs, projects, and clusters, then query and (with confirmation) modify data on those clusters.
- Use the Deep Agents harness: virtual filesystem, subagents, planning, and skills with progressive disclosure.
- Talk to Atlas through the **Atlas Managed MCP Server** (remote). Do not run or register local Atlas deployment tools.
- Keep secrets and model choice in environment variables so the same graph can run locally and, later, on Magenta.

## Architecture

`createDeepAgent` from [`deepagents`](https://docs.langchain.com/oss/javascript/deepagents/overview) is the agent factory. It returns a compiled [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/overview) graph (streaming, checkpointers, Studio). Deep Agents sits on LangChain building blocks; we do not hand-roll a `createAgent` MCP loop.

```
User (local chat UI)
        │
        ▼
createDeepAgent  ── LangGraph graph
        │
        ├── Chat model (ChatOpenAI / initChatModel)
        │           ▲
        │           │  OPENAI_API_KEY + OPENAI_BASE_URL
        │           │  MODEL (optional)
        ├── System prompt (sys-prompt-draft.md)
        ├── SkillsMiddleware  ← mongodb/agent-skills (progressive disclosure)
        ├── Filesystem + subagents + optional todo planning
        └── MCP tools  ← Atlas Managed MCP Server (HTTP + OAuth bearer)
                    ▲
                    │  token (client credentials)
                    │
         Atlas Admin API (digest)
         ORG_ID + PUBLIC_API_KEY + PRIVATE_API_KEY
         → MCP config + secret, ipAccessList
```

### Runtime pieces

| Piece | Role |
| --- | --- |
| `createDeepAgent` | Assembles the harness and compiles the graph. |
| `SkillsMiddleware` | Injected when `skills` is passed (or via `createSkillsMiddleware`). Discovers `SKILL.md` frontmatter at start; the model reads full skill files on demand. |
| `FilesystemMiddleware` | Virtual filesystem (`ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`) for skill bodies, large tool results, and working notes. |
| `SubAgentMiddleware` | `task` tool: ephemeral subagents with isolated context. General-purpose subagent inherits main-agent skills. |
| Planning | Opt-in `todoListMiddleware` / `write_todos` for multi-step exploration. Enable it; exploration workflows are multi-step. |
| MCP tools | Loaded once at process start via `@langchain/mcp-adapters` (`MultiServerMCPClient`) and passed as `tools`. |
| HITL | `interrupt_on` for destructive MCP tools (drop, delete, unfiltered update), matching the system prompt. |

### Proposed package layout

pnpm workspaces. TypeScript throughout. The frontend streams the compiled LangGraph graph via `useStream`; the packages share no code.

```
packages/
  agent/                 # @mongodb-agent-template/agent
    langgraph.json       # LangGraph CLI: graph export + root .env
    src/
      agent.ts           # createDeepAgent wiring
      graph.ts           # LangGraph CLI export (`graph` = createGraph)
      env.ts             # loads root .env + package overrides
      llm.ts             # ChatOpenAI / initChatModel from env
      mcp/
        bootstrap.ts     # Admin API: MCP config + secret, ipAccessList
        oauth.ts         # client-credentials token fetch / cache / refresh
        client.ts        # MultiServerMCPClient → tools
      prompt.ts          # system prompt
    skills/              # vendored snapshot of mongodb/agent-skills (not cloned at setup)
  frontend/              # @mongodb-agent-template/frontend
    src/                 # local LangChain UI (useStream)
pnpm-workspace.yaml
package.json             # private workspace root (`pnpm langgraph` → agent `dev`)
```

Agent dependencies: `deepagents`, `dotenv`, `langchain`, `@langchain/core`, `@langchain/langgraph`, `@langchain/langgraph-cli`, `@langchain/openai`, `@langchain/mcp-adapters`. Frontend uses `@langchain/langgraph-sdk` (`useStream`) plus one of the [LangChain frontend integrations](https://docs.langchain.com/oss/javascript/langchain/frontend/integrations/overview).

## Tools and MCP integration

Tools come from the [MongoDB MCP Server](https://www.mongodb.com/docs/mcp-server/tools/). The agent uses the **Atlas Managed** (remote) server at `https://mcp.mongodb.com`, not the local MCP process and not local Atlas deployment tools.

### Included categories

1. **Atlas tools** — orgs, projects, clusters, access lists, DB users, alerts, Performance Advisor, sample data, Stream Processing (`atlas-streams-*`), `remote-atlas-connect` / cluster connect.
2. **Database tools** — connect, find, aggregate, CRUD, indexes (including vector search), schema, stats, logs, export.
3. **Assistant tools** — `list-knowledge-sources`, `search-knowledge`.

### Excluded

**Local Atlas tools** are not included: `atlas-local-list-deployments`, `atlas-local-create-deployment`, `atlas-local-connect-deployment`, `atlas-local-delete-deployment`. Connecting to the managed server is sufficient; if those names ever appear in a tool list, do not register them.

### Authentication

The user supplies Atlas **programmatic API keys**, not MCP client credentials:

| Input | Purpose |
| --- | --- |
| `ORG_ID` | Organization for the remote MCP configuration. |
| `PUBLIC_API_KEY` | Atlas Admin API public key (HTTP digest). |
| `PRIVATE_API_KEY` | Atlas Admin API private key. |

Those keys cannot call the Managed MCP Server directly. The template implements the same two-step path documented for [AI framework clients](https://www.mongodb.com/docs/mcp-server/get-started/?ai-client=ai-frameworks-clients) and mirrored by [`mongodb-atlas-mcp-remote`](https://github.com/mongodb-js/mongodb-mcp-server/tree/main/packages/mongodb-atlas-mcp-remote): API keys → MCP config credentials → OAuth access token → MCP HTTP.

Do **not** spawn `npx mongodb-atlas-mcp-remote` as a stdio sidecar. MongoDB’s LangChain guidance is to fetch a token and call the managed server from application code. Reimplement the token fetch, cache, and refresh behavior of that package in-process.

**Bootstrap (once per agent instance, or when the local cache is missing):**

1. Digest-authenticate to the Atlas Admin API with `PUBLIC_API_KEY` / `PRIVATE_API_KEY`.
2. Create an organization MCP configuration (`createOrgMcpConfig`) with a **per-session name** `mongodb-agent-template-<uuid>`, roles (e.g. `ORG_OWNER`), and `ipAccessList` containing the caller’s IP. Each instance gets its own service account / secret so one token can be revoked without affecting others. Reuse only this instance’s gitignored `.mcp-credentials.json`. Pin a stable name with `MCP_CONFIG_NAME` only when you explicitly want to share a config.
3. Create a secret (`createOrgMcpSecret`). The secret is returned once. Persist `mcpConfigId`, `clientId`, and `clientSecret` as process secrets, not in the LLM context. Do not mint a second secret on a pinned config that already has remote secrets.

**Runtime (every MCP session):**

1. `POST https://cloud.mongodb.com/api/oauth/token` with Basic `clientId:clientSecret` and `grant_type=client_credentials`.
2. Attach `Authorization: Bearer <access_token>` (plus MCP protocol headers) to Streamable HTTP against `https://mcp.mongodb.com`.
3. `MultiServerMCPClient.getTools()` → pass into `createDeepAgent({ tools })`.
4. Refresh the token before expiry; do not put tokens in prompts or tool results.

### IP allowlist

Atlas Managed MCP requires the caller’s IP or CIDR on the MCP configuration’s `ipAccessList`. This is separate from the cluster’s Atlas Network Access list.

| Environment | What to allowlist |
| --- | --- |
| Local | The developer machine’s public IP. Resolve it at bootstrap (e.g. `ifconfig.me` or equivalent). DeepAtlas uses a similar 403 → detect IP → `atlas accessLists create --currentIp` pattern for cluster access; apply the same idea to MCP `ipAccessList`. |
| Magenta | Platform egress IPs/CIDRs on the **user’s** MCP config. `agentic atlas setup` allowlists Magenta only on the cluster it provisions for platform state; it does not update the user’s MCP `ipAccessList`. The IP list is not published. See [Open questions](#open-questions-and-risks). |

## LLM configuration

LangGraph does not read API keys. Model packages do. The template constructs a chat model and passes it into `createDeepAgent({ model })`.

**Requirement:** OpenAI-compatible configuration via environment variables.

| Variable | Role |
| --- | --- |
| `OPENAI_API_KEY` | API key. `ChatOpenAI` reads this. |
| `OPENAI_BASE_URL` | Base URL (optional). |
| `OPENAI_USE_RESPONSES_API` | Transport override: `auto` (default), `true`, or `false`. |
| `MODEL` | Model id; default to gpt-4o if unset. |

Construct with `ChatOpenAI` from `@langchain/openai`, or `initChatModel("openai:...")` / `createAgent({ model: "openai:..." })`. For non-OpenAI endpoints, set `configuration.baseURL` from `OPENAI_BASE_URL`. That covers vanilla OpenAI, Azure OpenAI (when the endpoint is OpenAI-compatible), and other compatible gateways. The default `auto` transport sets `useResponsesApi: true` for GPT-5 and o-series reasoning models so function tools and reasoning use `/v1/responses`; other models retain LangChain's normal routing. Gateways without Responses support can set the override to `false`, while `true` forces Responses for any model.

If a dedicated Azure client is used, use `AzureChatOpenAI` and the `AZURE_OPENAI_*` family (`AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_BASE_PATH`, and related). That is optional; base URL on `ChatOpenAI` is the minimum for Azure-shaped endpoints.

Optional, same pattern: `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL` with `ChatAnthropic`. Not required for v0.

On Magenta, the user supplies the LLM key as a platform secret. Whether Magenta secrets are injected as process env vars is not documented; the code should read env vars either way.

## System prompt and skills

### System prompt

The v0 system prompt is [`sys-prompt-draft.md`](sys-prompt-draft.md), adapted from the [DeepAtlas Skunkworks agent](https://github.com/mongodb/ai-assistant/pull/268). Pass it as `systemPrompt` on `createDeepAgent`.

Behavioral constraints the graph must honor in code as well as prompt text:

- Act only on explicit user requests.
- Prefer read-only exploration, then ask before writes.
- Confirm before destructive operations (drop, delete, update without filter). Implement this with `interrupt_on` for those MCP tools, not prompt-only.

### Skills

Load [MongoDB Agent Skills](https://github.com/mongodb/agent-skills) through Deep Agents, not a coding-agent marketplace plugin.

- **Vendor** a copy of [mongodb/agent-skills](https://github.com/mongodb/agent-skills) into `packages/agent/skills/`. Do not clone at setup or pull `main` at runtime. Bumping means copying a newer snapshot into the repo (not auto-updating). Skills are `SKILL.md` plus supporting files (Agent Skills standard).
- Pass `skills: ["<path-to-skills>"]` to `createDeepAgent`, which installs `SkillsMiddleware` (`createSkillsMiddleware`) **before** filesystem middleware so skill metadata is in the system prompt before file tools run.
- Progressive disclosure: frontmatter `name` / `description` at startup; full `SKILL.md` via `read_file` when needed; supporting files only as the skill instructs.

Documented skills include MCP setup, connection configuration, schema design, natural-language querying, query optimization, Atlas Search / Vector Search, and Atlas Stream Processing. They complement MCP tools; they do not replace them.

## Deployment

### Local (v0)

A local deployment for testing. It should look like a real chat product; it does not need to be production-hardened.

- Run the compiled LangGraph graph from `packages/agent` (`pnpm langgraph` → `langgraphjs dev --no-browser`). LangGraph CLI / Studio is acceptable for developers; `--no-browser` keeps Studio from auto-opening.
- User-facing UI in `packages/frontend`: [LangChain frontend integrations](https://docs.langchain.com/oss/javascript/langchain/frontend/integrations/overview) on top of `useStream`. **v0 choice:** [AI Elements](https://docs.langchain.com/oss/javascript/langchain/frontend/integrations/overview) (shadcn `Conversation`, `Message`, `Tool`, `Reasoning`) wired to `stream.messages`. That surfaces MCP tool calls without a custom runtime. CopilotKit, assistant-ui, or OpenUI remain compatible if the local UI is swapped later.
- Local env file (not committed): single root `.env` (copied from `.env.example`), automatically loaded by `packages/agent/src/env.ts` (with optional package-level `.env` overrides). Contains Atlas `ORG_ID` / `PUBLIC_API_KEY` / `PRIVATE_API_KEY` and LLM provider credentials.

### Magenta (later, not v0)

Borrow from DeepAtlas Skunkworks ([ai-assistant#268](https://github.com/mongodb/ai-assistant/pull/268)) when this is scheduled. Do not design Magenta packaging, secrets, or networking as part of the first implementation.

Notes for that phase:

- **CLI:** [`agentic invoke`](https://feature-agentic-plat--docs-on-nextjs.netlify.app/docs/agentic-platform/invoke-agent/#invoke-an-agent-from-the-cli). A TUI is a Magenta-team / V1 discussion, not v0.
- **UI:** Magenta chat UI for the first Magenta drop. It is the only UI that does not require a custom client or server.
- **LLM key:** user-provided Magenta secret.
- **MCP IP allowlist:** Magenta egress IPs must be on the user’s MCP `ipAccessList`. `agentic atlas setup` does not do that. Get-started: [agentic platform](https://feature-agentic-plat--docs-on-nextjs.netlify.app/docs/agentic-platform/get-started).

## Open questions and risks

1. **Magenta egress IPs.** Docs state that Magenta has egress IPs; the values are not published. Managed MCP will 403 until those CIDRs are on `ipAccessList`. Blocker for Magenta; obtain the list from the Magenta team and verify against a deployed agent. Not a local-v0 blocker.
2. **Magenta secrets as env vars.** No public confirmation that platform secrets appear as `OPENAI_API_KEY` (or equivalent) in the agent process. Keep a thin env adapter so mapping can change without touching model construction.
3. **MCP config leak.** Per-session configs (`mongodb-agent-template-<uuid>`) avoid sharing one service account, but deleting `.mcp-credentials.json` or restarting without a cache creates another Atlas MCP config. Orphaned configs are not auto-deleted. Pin `MCP_CONFIG_NAME` for a stable identity; that path still refuses extra secrets if the local cache is gone.
