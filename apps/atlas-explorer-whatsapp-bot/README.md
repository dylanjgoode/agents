# Atlas Explorer WhatsApp bot

A [Chat SDK](https://chat-sdk.dev) client that lets a few known people ask the
[Atlas Explorer agent](../../agents/atlas-explorer) questions over WhatsApp.
It's a thin app on
[`@repo/agent-engine-chat`](../../packages/agent-engine-chat) and the
`@chat-adapter/whatsapp` package, built the same way as the
[Slack bot](../atlas-explorer-slack-bot).

- **[`@repo/agent-engine-chat`](../../packages/agent-engine-chat)** invokes
  Agent Engine, maps each chat to an agent session in MongoDB, applies the
  allowlist, and enforces the hourly session limit.
- **This app** adds the WhatsApp adapter, environment loading, the Vercel
  webhook, and two WhatsApp-specific behaviors:
  - [`src/readOnlyAgent.ts`](./src/readOnlyAgent.ts) rejects every write
    the agent proposes. See [Read-only](#read-only).
  - [`src/platforms/whatsapp.ts`](./src/platforms/whatsapp.ts) sends at most
    one typing indicator every 20 seconds. The stock adapter makes a Graph API
    call for every agent progress update.

## Before you use this

This bot is an example to learn from and adapt. You host and operate it
yourself, and you need your own Meta WhatsApp Business account.

## How it behaves

- **Every chat is a DM.** WhatsApp has no channels or threads. Each person's
  chat with the bot's number is one thread and one Agent Engine session, so
  follow-ups such as "and last week?" keep their context.
- **One message per answer.** WhatsApp can't edit or stream messages. The bot
  shows a typing indicator while the agent works, then sends the answer.
  Answers over 4,096 characters arrive as several messages.
- **The 24-hour window.** WhatsApp accepts free-form messages only within 24
  hours of the person's last message. This bot only replies, so it's always
  inside the window. Messages the bot starts need approved templates, which
  this app doesn't send yet.

## Read-only

The bot never asks for approval. When Atlas Explorer pauses before a write,
the bot rejects it and sends the agent's next reply, which explains that the
change can't be made from WhatsApp.

WhatsApp cuts interactive message bodies at 1,024 characters but keeps the
buttons. An approval card could therefore show an Approve button under
arguments the person can't fully see, so this app doesn't offer one.

The rejection only covers writes that pause for review. Point the bot at a
workspace with writes off (`ALLOW_WRITE_OPERATIONS` unset) and an MCP
configuration with read-only Atlas roles, so the agent can't write at all.

## Prerequisites

- Node.js 24 and pnpm
- A deployed Atlas Explorer workspace and a project-scoped Agent Engine
  service account. The [Slack bot README](../atlas-explorer-slack-bot#prerequisites)
  shows how to create one.
- A Meta Business portfolio, a Meta app with the WhatsApp product, and a phone
  number registered for the WhatsApp Business Platform.
- MongoDB 5.0+ for thread state in production. Locally, the bot can start a
  temporary database.

## Configure WhatsApp

1. In [Meta for Developers](https://developers.facebook.com/apps), create a
   **Business** app and add the **WhatsApp** product.
2. Under **WhatsApp → API Setup**, add the phone number and copy its
   **Phone Number ID** as `WHATSAPP_PHONE_NUMBER_ID`.
3. In Meta Business Suite, create a System User with access to the app and
   the WhatsApp account. Generate a token with `whatsapp_business_messaging`
   and `whatsapp_business_management` and save it as
   `WHATSAPP_ACCESS_TOKEN`. The token on the API Setup page expires after 24
   hours.
4. Copy **App Settings → Basic → App Secret** as `WHATSAPP_APP_SECRET`.
5. Pick any random string as `WHATSAPP_VERIFY_TOKEN`.
6. Copy `.env.example` to `.env` and fill in the WhatsApp, Agent Engine, and
   allowlist values. `CHAT_ALLOWED_USER_IDS` takes phone numbers in
   international format, for example
   `whatsapp:447700900123,whatsapp:15550001111`.

You set the webhook URL after the bot is running, because Meta checks it
straight away.

## Run locally

Meta only calls public HTTPS URLs, so run the bot behind a tunnel such as
`cloudflared` or `ngrok`:

```bash
pnpm install
pnpm start
cloudflared tunnel --url http://localhost:3001
```

`pnpm start` serves the webhook at `/api/webhooks/whatsapp` on port 3001
(`PORT` changes it). Without `MONGODB_URI` it starts a temporary MongoDB
whose data disappears on shutdown.

Then, under **WhatsApp → Configuration** in the Meta app:

1. Set **Callback URL** to `<tunnel-url>/api/webhooks/whatsapp` and **Verify
   token** to `WHATSAPP_VERIFY_TOKEN`, and choose **Verify and save**.
2. Under **Webhook fields**, subscribe to `messages`. Also subscribe to
   `user_id_update` so chats survive Meta's username identifiers changing.

Message the bot's number from an allowlisted phone.

To run Atlas Explorer locally too, start it with `agentengine dev up` and set
`AGENTIC_INVOKE_TARGET=local`, as described in the
[Slack bot README](../atlas-explorer-slack-bot#invoke-the-agent-locally-too).

## Deploy to Vercel

The deployment matches the
[Slack bot's](../atlas-explorer-slack-bot#deploy-to-vercel), with a different
root directory, function, and variables:

1. Set the Vercel project's Root Directory to
   `apps/atlas-explorer-whatsapp-bot` and link it:

   ```bash
   pnpm install --frozen-lockfile
   pnpm vercel link --project "$VERCEL_PROJECT" --scope "$VERCEL_SCOPE"
   ```

2. Set these Production environment variables:
   - `WHATSAPP_ACCESS_TOKEN`
   - `WHATSAPP_APP_SECRET`
   - `WHATSAPP_PHONE_NUMBER_ID`
   - `WHATSAPP_VERIFY_TOKEN`
   - `CHAT_ALLOWED_USER_IDS`
   - `AGENTIC_INVOKE_TARGET` (`gateway`)
   - `AGENTIC_SA_CLIENT_ID`
   - `AGENTIC_SA_CLIENT_SECRET`
   - `AGENTIC_PROJECT_ID`
   - `AGENTIC_WORKSPACE_ID`
   - `MONGODB_URI`
   - Optional: `WHATSAPP_BOT_DISPLAY_NAME`, `THREAD_STORE_DB` (defaults to
     `atlas_explorer_whatsapp`), `SESSION_LIMIT_PER_HOUR`,
     `SESSION_IDLE_TTL_SECONDS`

3. Deploy with `pnpm deploy`, then set the Meta app's Callback URL to
   `$VERCEL_URL/api/webhooks/whatsapp`. Deployment Protection must not cover
   that domain.

The function handles Meta's `GET` verification and signed `POST` events at
`/api/webhooks/whatsapp`, with a 300-second maximum duration. It acknowledges
Meta at once and finishes the agent call with Vercel's `waitUntil`.

The thread-store network setup is the same as the Slack bot's: allow Vercel to
reach the MongoDB cluster that holds thread state.

## Security

- **One shared Atlas identity.** Everyone on the allowlist has the same Atlas
  access, through the workspace's MCP credentials. Give it only the roles
  every allowlisted person should have.
- **An allowlist is required.** The bot won't start without
  `CHAT_ALLOWED_USER_IDS`. Anyone else who messages the number gets "You are
  not authorized to use this AtlasExplorer bot." The bot logs the rejected
  ID, for example `Rejected unauthorized actor { actorId: 'whatsapp:…' }`.
  If an allowlisted person is rejected, Meta may be sending a
  business-scoped user ID instead of their phone number. Add that logged ID to
  the allowlist.
- **Requests are verified.** The bot rejects any event without a valid
  `X-Hub-Signature-256` made with `WHATSAPP_APP_SECRET`.
- **Each run records who asked.** The bot sends the WhatsApp ID and profile
  name with each request. Atlas Explorer stores them as
  `metadata.requester` on the session's checkpoints.
- **Anyone holding an allowlisted phone can ask.** WhatsApp identifies the
  number, not the person. Treat a lost phone like a leaked credential and
  remove the number from the allowlist.

## Development checks

```bash
pnpm test
pnpm typecheck
pnpm build
```

The tests sign webhook payloads the way Meta does and stub the Graph API with
`fetch`, so they don't need a Meta account, Agent Engine, or MongoDB.
