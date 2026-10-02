# Contributing to MongoDB Agents

This repository is a pnpm monorepo. It holds MongoDB agents that run on
[Atlas Agent Engine](https://www.mongodb.com/docs/agentengine/), plus the
shared libraries and chat clients that go with them. Each agent is a
workspace that you build, test, and deploy from here.

To report a bug or suggest an agent,
[open an issue](https://github.com/mongodb/agents/issues).

## Repository layout

| Path | What it is |
| --- | --- |
| [`agents/atlas-explorer`](agents/atlas-explorer) | The Atlas Explorer agent: a deployable Agent Engine app with `agent.yaml`, skills, and the esbuild bundle. |
| [`agents/query-analysis`](agents/query-analysis) | The Atlas Query Insights agent: a deployable Agent Engine app that reports on slow queries from Performance Advisor. |
| [`apps/atlas-explorer-slack-bot`](apps/atlas-explorer-slack-bot) | The example `@AtlasExplorer` Slack client. |
| [`packages/agent-engine-core`](packages/agent-engine-core) | Shared Agent Engine runtime: LLM selection, tool policy, and LangGraph middleware. |
| [`packages/atlas-explorer-agent`](packages/atlas-explorer-agent) | Atlas Explorer's tool allowlist, prompts, and middleware. |
| [`packages/query-analysis-agent`](packages/query-analysis-agent) | Atlas Query Insights' tool policy, prompts, Performance Advisor evidence, and middleware. |
| [`packages/agent-engine-chat`](packages/agent-engine-chat) | A Chat SDK client library for any Agent Engine agent: handlers, the Agent Engine client, and thread storage. |
| [`scripts/seed-pa-slow-queries`](scripts/seed-pa-slow-queries) | A script that loads slow-query data into an Atlas cluster for Performance Advisor. It drops the `highImpact` database. |
| [`agent.yaml`](agent.yaml) | The Agent Engine monorepo manifest. Each entry is a workspace under `agents/`. |
| [`project-config.yaml`](project-config.yaml) | Project-level Agent Engine settings, currently memory. |
| [`.agentengineignore`](.agentengineignore) | Files left out of the source archive that `agentengine build` uploads. |
| [`.agents/skills`](.agents/skills) | Coding-agent skills for working in this repository. |
| [`.cursor`](.cursor) | The Cursor Cloud Agent environment. Its [install script](.cursor/install.sh) shows how to install the `agentengine` CLI. |
| [`.github`](.github) | CI workflows, the shared unit-test action, the pull request template, and `CODEOWNERS`. |

`tsconfig.base.json`, `tsconfig.test.base.json`, and `vitest.shared.mts` hold
the TypeScript and Vitest settings that every package extends.

The packages depend on each other in a chain. The Atlas Explorer app imports
`@repo/atlas-explorer-agent`, which re-exports `@repo/agent-engine-core`. The
Query Insights app imports `@repo/query-analysis-agent`. The
Slack bot imports `@repo/agent-engine-chat`. Consumers import each library's
compiled `dist` folder, so their `pre*` scripts build the libraries first.
If you run `vitest` or `tsc` directly, build the libraries yourself first.

## Prerequisites

- [pnpm](https://pnpm.io) 11.25.0, as pinned by `packageManager` in
  `package.json`. Run `corepack enable` to get it.
- Node.js. The version depends on what you work on:
  - 24 or later for `agents/atlas-explorer`, `agents/query-analysis`,
    `@repo/atlas-explorer-agent`, `@repo/agent-engine-core`, and
    `@repo/query-analysis-agent`.
  - 22.x for `apps/atlas-explorer-slack-bot`.
  - 22 or later for `@repo/agent-engine-chat` and the repository root.

  CI uses Node.js 24 for every package.
- The [`agentengine` CLI](https://www.mongodb.com/docs/agentengine/build/install-authenticate/)
  and Docker, to run an agent locally or to build and deploy it.
- `mongosh`, only for the seed script.

## Set up

```bash
corepack enable
pnpm install
pnpm test:atlas-explorer
pnpm test:slack-bot
```

Then follow the README of the part you're working on.

To run an Agent Engine workspace from the repository root, pass its name from
the root [`agent.yaml`](agent.yaml):

```bash
agentengine dev up --workspace atlas-explorer
```

From `agents/atlas-explorer`, `agentengine dev up` uses the same project
config.

## Root scripts

Run these from the repository root.

| Script | What it does |
| --- | --- |
| `pnpm test:atlas-explorer` | Tests `@repo/agent-engine-core`, `@repo/atlas-explorer-agent`, and `atlas-explorer`. |
| `pnpm test:slack-bot` | Tests `@repo/agent-engine-chat` and `@repo/atlas-explorer-slack-bot`. |
| `pnpm test:query-analysis` | Tests `@repo/query-analysis-agent` and `query-analysis`. |
| `pnpm build:atlas-explorer` | Builds `atlas-explorer` and the workspace packages it depends on. |
| `pnpm build:query-analysis` | Builds `query-analysis` and the workspace packages it depends on. |
| `pnpm build:slack-bot` | Builds `@repo/atlas-explorer-slack-bot` and the workspace packages it depends on. |

Each package also has its own `test` and `typecheck` scripts. Run them with
`pnpm --filter <package> <script>`.

## Continuous integration

Two GitHub Actions workflows run unit tests on pull requests and on pushes to
`main`. Each one runs only when files it covers change, such as its packages,
the lockfile, the shared TypeScript and Vitest config, or the workflow itself.

| Workflow | Runs |
| --- | --- |
| [`unit-tests-agents.yml`](.github/workflows/unit-tests-agents.yml) | One job each for `@repo/agent-engine-core`, `@repo/atlas-explorer-agent`, `atlas-explorer`, `@repo/query-analysis-agent`, and `query-analysis`. |
| [`unit-tests-slack-bot.yml`](.github/workflows/unit-tests-slack-bot.yml) | One job each for `@repo/agent-engine-chat` and `@repo/atlas-explorer-slack-bot`. |

Both workflows use the [`unit-test`](.github/actions/unit-test/action.yml)
action. It installs dependencies with `pnpm install --frozen-lockfile` on
Node.js 24 and runs the package's test script. CI doesn't run typecheck or
build, so run them locally before you open a pull request.

## Add a new agent

1. Create a workspace under `agents/<name>` with its own `agent.yaml`,
   `package.json`, and README. Use `agents/atlas-explorer` or
   `agents/query-analysis` as a reference.
2. Register the workspace in the root [`agent.yaml`](agent.yaml).
3. Put reusable behavior, such as prompts, tool policy, and middleware, in a
   package under `packages/` that builds on `@repo/agent-engine-core`.
4. Add the new packages to
   [`unit-tests-agents.yml`](.github/workflows/unit-tests-agents.yml), and add
   `test:<name>` and `build:<name>` scripts to the root `package.json`.
5. Add the agent to the table in the root [README](README.md).

## Pull requests

Fill in the [pull request template](.github/pull_request_template.md): a Jira
link, the changes, and any notes. [`CODEOWNERS`](.github/CODEOWNERS) assigns
reviewers. Keep each pull request focused on one change. Never commit `.env` files or
credentials. Don't edit `.agentengine/`, because the `agentengine` CLI
generates it.
