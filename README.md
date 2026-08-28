# mongodb-agent-template

TypeScript template for a MongoDB Data Explorer agent. pnpm workspace.

- [`packages/agent`](packages/agent) — Deep Agents / LangGraph graph (`@mongodb-agent-template/agent`)
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

