# Atlas Explorer (Magenta TypeScript)

Atlas Explorer is a MongoDB and Atlas operations agent running on the Magenta
Agentic Platform. It combines Magenta's audited deep-agent runtime with Atlas
Managed MCP tools and the MongoDB Agent Skills bundle.

**Features:** Deep-agent planning · Atlas Managed MCP · MongoDB skills ·
platform checkpoints · human approval for destructive operations

## Layout

```
atlas-explorer/agents/atlas-explorer/
├── agent.yaml                         # app, MCP, features, and required secret names
├── package.json / tsconfig.json       # TypeScript build
├── pnpm-workspace.yaml / pnpm-lock.yaml
├── dev.yaml                           # local Agentic service ports
├── env.example                        # copy to .env
├── skills/                            # vendored MongoDB Agent Skills
└── src/agent_atlas_explorer/
    ├── main.ts                        # startup bootstrap + Magenta deep agent
    ├── agentBackend.ts                # audited filesystem without model shell access
    ├── agentPolicy.ts                 # tool filtering and destructive-tool policy
    ├── modelResponse.ts               # removes repeated OpenAI tool metadata
    ├── toolErrors.ts                  # recoverable MCP error handling
    ├── systemMessage.ts               # Atlas Explorer instructions
    ├── llm.ts                         # provider selection
    └── mcp/
        ├── bootstrap.ts               # Atlas Admin API identity creation
        └── startup.ts                 # process-local credential injection
```

## Configure

Requires Node.js 24 or newer.

```bash
cp env.example .env
pnpm install
```

Set these local secrets in `.env`:

- `ATLAS_ORG_ID`
- `ATLAS_PUBLIC_API_KEY`
- `ATLAS_PRIVATE_API_KEY`
- the API key matching `config.provider` in `agent.yaml`

Use Atlas programmatic API credentials authorized to create organization MCP
configurations. Do not set `ATLAS_MCP_CLIENT_ID` or
`ATLAS_MCP_CLIENT_SECRET`; startup generates them in memory.

For a deployed workspace, store the same values in Magenta's secret store:

```bash
agentic secret set ATLAS_ORG_ID
agentic secret set ATLAS_PUBLIC_API_KEY
agentic secret set ATLAS_PRIVATE_API_KEY
agentic secret set OPENAI_API_KEY
```

When `agent.yaml` selects Anthropic, Gemini, Cerebras, or a custom-compatible
endpoint, update both provider-key entries under `required_secrets` and the
Tool Pod destination under `network.egress`. The checked-in manifest permits
the default OpenAI endpoint plus the Atlas, Managed MCP, and public-IPv4 hosts
needed during per-process bootstrap.

## MCP startup lifecycle

Each AER and Tool Pod process:

1. Resolves its public IPv4 address.
2. Creates a uniquely named Atlas organization MCP configuration with the
   `ORG_OWNER` role and that address in its access list.
3. Creates the configuration's one-time client secret.
4. Places the generated client ID and secret only in process memory.
5. Constructs the Magenta `App`, which discovers MCP tools from `agent.yaml`
   and obtains short-lived OAuth access tokens.

The generated service-account secret expires after one year. A new process
creates a new MCP configuration; stopped or crashed processes cannot delete
their remote configuration automatically. Operators should periodically remove
expired `atlas-explorer-*` configurations that are no longer in use.

## Run locally

```bash
pnpm test
pnpm typecheck
pnpm build
agentic dev up
```

Open the playground at http://localhost:3000. Stop the stack with
`agentic dev stop`.

## What to try

- Ask it to list databases or inspect a collection schema. Read-only MCP tools
  run without approval.
- Ask it to diagnose a query or propose an index. The agent can load the
  relevant MongoDB skill on demand.
- Ask it to drop a collection. The graph suspends before the MCP call and
  resumes only after an approve/edit/reject/respond decision.

## Safety and runtime notes

- Every mutative database tool—`insert-many`, `create-index`, `drop-index`,
  `update-one`, `update-many`, `rename-collection`, `create-collection`,
  `delete-many`, `drop-collection`, and `drop-database`—plus Atlas Streams
  lifecycle management and teardown is protected by LangChain HITL middleware
  using Magenta's persistent checkpointer and suspend/resume adapter.
- `aggregate` remains available for read-only exploration; the agent is
  explicitly forbidden from using `$out` or `$merge` write stages because HITL
  is applied at tool granularity.
- Deep-agent file operations stay on Magenta's audited Tool Pod backend, but
  the model is not given general-purpose shell execution that could read
  process credential files outside the filesystem sandbox.
- MCP validation and query errors are returned to the model so it can correct
  arguments and retry. Graph interrupts are always rethrown.
- OpenAI Responses tool definitions echoed in `response_metadata` are removed
  from prior messages before model calls and from new responses before
  checkpointing, keeping durable sessions compact.
- `atlas-local-*` tools are hidden because they cannot run against Managed MCP.
- The Magenta SDK dependencies are pinned to one tested commit in both
  `package.json` and `pnpm-workspace.yaml`.
- Zod is pinned to `4.4.3`; newer `4.5.x` releases currently break Magenta's
  content-block discriminator while messages cross the AER/Tool Pod boundary.
- Do not edit `.agentic/`; it is generated by the Agentic CLI.
