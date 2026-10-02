# MongoDB Agents

Open-source agent templates for MongoDB Atlas that you deploy to
[Atlas Agent Engine](https://www.mongodb.com/docs/agentengine/).

An agent for routine database work needs more than a prompt. It also needs
credentials, access scoping, tool orchestration, approval flows, and
somewhere reliable to run. Each template in this repository already includes
those pieces. It combines the
[MongoDB MCP Server](https://www.mongodb.com/docs/mcp-server/) and
[MongoDB Agent Skills](agents/atlas-explorer/skills) with the orchestration
for a specific Atlas workflow. You bring a model API key, set the agent's
scope, and deploy it to Atlas Agent Engine.

> [!NOTE]
> Atlas Agent Engine is in Public Preview. Review the
> [Agent Engine limitations](https://www.mongodb.com/docs/agentengine/reference/limitations/)
> before you deploy an agent against a production workload.

## Agents

| Agent | What it does | Status |
| --- | --- | --- |
| [Atlas Explorer](agents/atlas-explorer) | A conversational agent for questions and everyday workflows across your Atlas environment, such as clusters, alerts, schemas, and data. | Available |
| [Atlas Query Insights](agents/query-analysis) | A workflow agent that produces a slow-query report for an Atlas cluster, based on Performance Advisor. | Available |

Each agent has its own README with full configuration and deployment steps.

### Atlas Query Insights

Atlas Query Insights explains which slow queries on a cluster matter most and
what to look at next. It's read-only: it can recommend an index, but it can't
create one.

1. It pulls slow query logs and suggested indexes from
   [Performance Advisor](https://www.mongodb.com/docs/atlas/performance-advisor/)
   for one cluster.
2. It groups the logs into query shapes and ranks them by documents examined,
   then working time, then execution count.
3. It reports on the top three shapes. You can change that number in its
   `config.ts`. Each shape gets a plain-language overview and up to two areas
   worth investigating, usually with a link to the MongoDB docs. When
   Performance Advisor suggests an index for a shape, that suggestion comes
   first.

Things to know:

- It only names index fields that Performance Advisor suggested.
- The report is based on a sample of at most 50 recent slow query logs, not
  on every execution of a query over time.
- Performance Advisor requires an M10 or larger cluster.
- You can pin the agent to one project and cluster in its `config.ts`.

## Why Atlas Agent Engine

Atlas Agent Engine is the managed runtime for these agents. It handles
the infrastructure you would otherwise build and maintain yourself:

| Capability | How the templates use it |
| --- | --- |
| [Secrets management](https://www.mongodb.com/docs/agentengine/deploy/provision-secrets/) | Atlas MCP credentials and model API keys are stored as platform secrets. You declare their names in `agent.yaml`, and the values never live in your code. |
| Sandboxed execution | The agent and its tools run in separate sandboxes. Model calls and MCP tool calls run in the tool sandbox, and `agent.yaml` declares the secrets each one needs. |
| [Network egress policies](https://www.mongodb.com/docs/agentengine/network-egress/) | Outbound traffic is blocked by default. Each sandbox can reach only the hosts that `agent.yaml` allows for it, such as Atlas and your model provider. |
| Durable sessions | Agent Engine checkpoints each session. An agent can pause for a human decision and then resume where it left off. |
| [Execution traces](https://www.mongodb.com/docs/agentengine/manage/inspect-traces/) and [monitoring](https://www.mongodb.com/docs/agentengine/manage/monitor/) | You can inspect each run's model calls, tool calls, and errors. |
| [Playground](https://www.mongodb.com/docs/agentengine/deploy/test/) | You can test an agent locally before you deploy it. |
| [Service accounts](https://www.mongodb.com/docs/agentengine/api-keys-service-accounts/) | Other apps, such as the Slack bot example, can call a deployed agent. |

Agent Engine also offers
[agent memory](https://www.mongodb.com/docs/agentengine/add-features/memory-types/),
a [policy engine](https://www.mongodb.com/docs/agentengine/manage/governance/policy-engine/),
and more. See the [Agent Engine documentation](https://www.mongodb.com/docs/agentengine/)
for the full list.

## Get started

These steps deploy Atlas Explorer. The
[Atlas Explorer README](agents/atlas-explorer) covers each one in detail.
Atlas Query Insights follows the same steps from `agents/query-analysis`. See
its [README](agents/query-analysis) for details.

### Prerequisites

- An Atlas account and a project that holds the data you want to explore
- The [`agentengine` CLI](https://www.mongodb.com/docs/agentengine/build/install-authenticate/),
  installed and authenticated
- [Atlas CLI](https://www.mongodb.com/docs/atlas/cli/current/) 1.58 or later
- Node.js 24 or later, and [pnpm](https://pnpm.io/)
- Docker, to run the agent locally
- An API key for your model provider

### 1. Clone and install

```bash
git clone https://github.com/mongodb/agents.git
cd agents/agents/atlas-explorer
cp .env.example .env
cp mcp-config.example.json mcp-config.json
pnpm install
```

### 2. Set the agent's boundaries

Create an Atlas MCP configuration for one Atlas project with the Atlas CLI.
The roles you give that configuration decide what the agent can see and do.
The example grants read-only access. Add the client ID and secret it returns
to `.env`, along with your model API key.

Atlas Explorer uses OpenAI by default. To use Anthropic, Gemini, or Cerebras
instead, change the provider in `src/agent_atlas_explorer/config.ts`.

### 3. Test it locally

```bash
pnpm build
agentengine dev up
```

Open the Playground at http://localhost:3000 and ask a question, such as
"Which of my clusters have alerts?"

### 4. Deploy to Atlas Agent Engine

Store the same credentials as platform secrets, then build and deploy:

```bash
agentengine secret set ATLAS_MCP_CLIENT_ID
agentengine secret set ATLAS_MCP_CLIENT_SECRET
agentengine secret set OPENAI_API_KEY
agentengine build
agentengine deploy
```

Then call the deployed agent:

```bash
agentengine invoke "Which of my clusters have alerts?"
```

To learn more, see
[Deploy your build](https://www.mongodb.com/docs/agentengine/deploy/deploy-build/)
and the [`agentengine` CLI reference](https://www.mongodb.com/docs/agentengine/cli/agentengine/).

## Safe by default

Agents that can see production data need clear limits. The templates set
those limits from the start.

- **Read-only by default.** Agents connect to Atlas with their own
  programmatic identity, and you choose its roles. The example configuration
  grants read-only access to one Atlas project.
- **Two opt-ins to enable writes.** To make writes possible, you must
  provision a write-capable Atlas identity *and* set
  `ALLOW_WRITE_OPERATIONS`. If either one stays read-only, the agent cannot
  write.
- **Human approval for every write.** When writes are enabled, any action that
  changes a database or an Atlas configuration pauses for explicit approval.

## Example: talk to Atlas Explorer from Slack

[`apps/atlas-explorer-slack-bot`](apps/atlas-explorer-slack-bot) is an
example of how to connect a deployed agent to the tools your team already
uses. It calls Atlas Explorer on Agent Engine with a service account. You can
ask questions in a channel or DM, approve or reject proposed writes, and post
read-only reports on a schedule with Slack Workflow Builder.

This bot is an example to learn from and adapt. It isn't a managed Slack app.
You host and operate it yourself. Read these limitations before you use it:

> [!IMPORTANT]
> The Slack bot connects to Atlas with **one shared programmatic identity**.
> It does not use each Slack user's own Atlas permissions.

- An allowlist of Slack users controls who can message the bot. The bot won't
  start without one.
- Anyone on the allowlist can reach everything that the shared identity can
  reach. Give that identity only the roles every allowlisted user should
  have.
- Only the user who requested a write can approve or reject it.
- Each run records which Slack user made the request.
- The bot needs its own host and its own MongoDB database to store thread
  state.

## What to expect

- **Atlas only.** The agents depend on Atlas-hosted services such as the
  Atlas MCP Server. They don't support MongoDB Enterprise Advanced,
  on-premises deployments, or Atlas for Government.
- **Built for Atlas Agent Engine.** You can fork the code and adapt it under
  the Apache 2.0 license. However, the deployment steps in this repository
  cover only Atlas Agent Engine and the `agentengine` CLI.
- **You run your deployment.** These templates are starting points that you
  deploy and operate in your own Atlas and Agent Engine projects.

## Contributing

To learn about the repository layout, local development, tests, and adding a
new agent, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Feedback

Did you build something with these templates, or hit a rough edge?
[Open an issue](https://github.com/mongodb/agents/issues). Your feedback shapes
which agents we build next.

## License

[Apache 2.0](LICENSE)
