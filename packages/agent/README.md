# `@mongodb-agent-template/agent`

Deep Agents / LangGraph graph for exploring MongoDB Atlas. `graph` is the compiled Deep Agent factory (`createGraph`) loaded by LangGraph CLI / Studio (`langgraph.json` → `./src/graph.ts:graph`).

Vendored skills live in `skills/`. The local UI in `@mongodb-agent-template/frontend` streams this graph; this package does not depend on the frontend.

## Run

From the repo root, copy `.env.example` to `.env` and fill in Atlas and LLM credentials:

```bash
cp .env.example .env
pnpm install
pnpm langgraph
```

That runs `langgraphjs dev --no-browser` in this package. It starts only the local Agent Server at `http://localhost:2024` (no Docker) and does not open or require the hosted LangSmith Studio frontend.

The CLI may still print the optional Studio URL, but `--no-browser` prevents launching it. LangSmith Studio is a separately hosted web frontend, even when it connects to this local API. This repository does not provide a fully local Studio UI. For a fully local web UI, implement the placeholder `@mongodb-agent-template/frontend` package.

The JS CLI has no `watch` field in `langgraph.json`. `langgraphjs dev` hot-reloads graph source and restarts when `langgraph.json` or the env file changes.
