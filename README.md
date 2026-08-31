# mongodb-agent-template

TypeScript template for a MongoDB Data Explorer agent. pnpm workspace.

- [`packages/agent`](packages/agent) — Deep Agents / LangGraph graph (`@mongodb-agent-template/agent`); local LangGraph API via `pnpm langgraph`
- [`packages/frontend`](packages/frontend) — local chat UI (`@mongodb-agent-template/frontend`)

The frontend streams the agent graph; the packages share no code. See [`docs/tech-design.md`](docs/tech-design.md).

## Getting Started

1. Copy `.env.example` to `.env` at the root and fill in your Atlas and LLM credentials:
   ```bash
   cp .env.example .env
   ```
2. Install dependencies:
   ```bash
   pnpm install
   ```
3. Start the local LangGraph API at `http://localhost:2024`:
   ```bash
   pnpm langgraph
   ```

   This starts `langgraphjs dev --no-browser`; it does not open or require the hosted LangSmith Studio frontend. A fully local web UI requires implementing the placeholder [`packages/frontend`](packages/frontend) package.
