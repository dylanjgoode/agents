# AtlasExplorer Slack Bot

`@AtlasExplorer` is a Slack client for the existing
[Magenta Atlas Explorer agent](../agents/atlas-explorer). The bot does not run
LangGraph, MCP, or Atlas credentials. It sends Slack messages to the Agentic
Platform invocation API, maps Slack threads to Agentic sessions, and presents
Approve/Reject controls when Atlas Explorer suspends for human review.

The initial integration uses the Magenta workspace's shared Atlas MCP identity.
Every allowlisted Slack user therefore has the same Atlas access as that
workspace; access is not scoped to each user's Atlas identity.

## Prerequisites

- Node.js 22 or newer and pnpm
- A Slack workspace where you can create and install an app
- Either a deployed Atlas Explorer workspace and Agentic Platform API key, or
  a local Atlas Explorer `agentic dev` stack
- For Vercel only, MongoDB 5.0+ for persistent thread mappings and partial TTL
  retention indexes

Configure and verify the Atlas Explorer agent first. Its
[README](../agents/atlas-explorer/README.md) covers MCP and model secrets.

```bash
cd ../agents/atlas-explorer
agentic build
agentic deploy
agentic api-key create
agentic invoke --json "List the Atlas projects I can access"
```

For a deployed agent, the JSON probe confirms the project/workspace target and
the current `session_id` invocation contract before Slack is involved.

## Configure the Slack app

1. In [Slack app management](https://api.slack.com/apps), choose **Create New
   App → From an app manifest** and paste `manifest.json`.
2. Under **Basic Information → App-Level Tokens**, create a token with
   `connections:write`. This is `SLACK_APP_TOKEN` and is only used for local
   Socket Mode.
3. Install the app to the workspace and copy its **Bot User OAuth Token** as
   `SLACK_BOT_TOKEN`.
4. Copy `.env.example` to `.env` and set the Slack and Agentic target values. Set
   `SLACK_ALLOWED_USER_IDS` to the comma-separated Slack member IDs of trusted
   operators (copy each member ID from the Slack profile menu).

The manifest requests message/history access for DMs, public channels, and
private channels. Add the app to each channel where users will mention it.

## Run locally with Socket Mode

The Slack bot can run entirely on localhost; Vercel and an inbound tunnel are
not required. Socket Mode opens an outbound WebSocket to Slack.

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm start
```

`MONGODB_URI` is optional locally. Without it, thread mappings live in memory
for 24 hours and reset when the process restarts. You can then:

- DM `@AtlasExplorer`; each top-level DM starts a new conversation.
- Mention `@AtlasExplorer` in a channel; the response starts a thread.
- Send follow-ups in a thread already owned by the bot.

By default, the local bot invokes a deployed Magenta workspace. The Atlas MCP
client credentials remain configured on Magenta and never enter the Slack bot
environment.

`SLACK_ALLOWED_USER_IDS` is required in both Socket and HTTP modes. The bot
refuses to start without an explicit allowlist because every permitted user
acts through the Magenta workspace's shared Atlas identity.

### Invoke the agent locally too

To run the Slack bot and Atlas Explorer agent without deploying either one,
start Atlas Explorer in its own terminal:

```bash
cd ../agents/atlas-explorer
agentic dev up
```

Then configure the Slack bot:

```dotenv
AGENTIC_INVOKE_TARGET=local
AGENTIC_BASE_URL=http://localhost:3000
AGENTIC_API_KEY=
AGENTIC_PROJECT_ID=
AGENTIC_WORKSPACE_ID=
```

Start the bot with `pnpm start`. The client calls the Playground's
`/invoke/stream` proxy on port 3000, which injects the local workspace scope
before forwarding to OE. Magenta tool progress updates the transient Slack
thread status; streamed model text is collected and posted once as the durable
final response. Do not point the client directly at OE port 8000 because the
client relies on the Playground proxy to inject that scope. Atlas MCP
credentials come from the agent's local `.env`.

## Deploy to Vercel

1. Import `atlas-explorer/slack-bot` as the Vercel project root.
2. Enable Fluid Compute and set these environment variables:
   - `SLACK_BOT_TOKEN`
   - `SLACK_SIGNING_SECRET`
   - `SLACK_ALLOWED_USER_IDS`
   - `AGENTIC_INVOKE_TARGET` (`gateway`)
   - `AGENTIC_BASE_URL`
   - `AGENTIC_API_KEY`
   - `AGENTIC_PROJECT_ID`
   - `AGENTIC_WORKSPACE_ID`
   - `MONGODB_URI`
   - `THREAD_STORE_DB` (optional; defaults to `atlas_explorer_slack`)
3. Deploy, then replace every `https://example.com/api/slack/events` URL in the
   Slack manifest with `https://<your-vercel-domain>/api/slack/events`.
4. Set `settings.socket_mode_enabled` to `false`, save the Slack app changes,
   and reinstall the app if Slack requests it.

The Vercel handler uses `@vercel/slack-bolt` so Slack is acknowledged within
three seconds while Magenta work continues through `waitUntil`. Its maximum
duration is 300 seconds. Vercel always uses the MongoDB thread store because
serverless memory does not survive cold starts. Completed inactive mappings
expire after 30 days, and an undelivered response is retained for up to 24
hours. Records with pending reviews or active work are excluded from
expiration. Treat long-lived pending or uncertain reviews as operational
alerts: verify Agentic/Atlas state before archiving those records.

Allow Vercel to reach the thread-store MongoDB deployment. Atlas MCP network
allowlisting is separate: MCP runs from Magenta, so allow the Magenta runtime's
egress addresses rather than Vercel's addresses.

## Human review

Mutative Atlas Explorer tools suspend with an `agent_interrupt`. The bot stores
the Agentic `session_id`, execution ID, all pending interrupts, and resume
schema, then posts Approve and Reject buttons. Only an allowlisted Slack user
who requested the operation can decide it. New text is blocked while review is
pending.

Both buttons continue the same session by sending a `resume_map` keyed by the
pending interrupt IDs. The bot does not use the generic execution `/resume`
endpoint. An unconfirmed resume is marked uncertain and is never
automatically replayed; verify Atlas state before starting a new conversation.

## Development checks

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm peers check
```

Tests mock external HTTP and Slack boundaries; they do not require a Slack
workspace, Magenta deployment, Docker, or MongoDB server.
