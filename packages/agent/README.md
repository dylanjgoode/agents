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

The JS CLI has no `watch` field in `langgraph.json`. `langgraphjs dev` hot-reloads graph source and restarts when `langgraph.json` or the env file changes.

## Playground UI

You can use the LangGraph Agent Chat UI to interact with the agent.

1. Run the server locally with `pnpm langgraph`
2. Open the Agent Chat UI at `https://agentchat.vercel.app/?apiUrl=http://localhost:2024&assistantId=agent`
3. You should be able to interact with the agent running locally from that website.
