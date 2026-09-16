# Bug report triage index

This directory contains 22 reports from the Atlas Explorer migration and local
runtime investigation. Severity and priority are proposed; component owners
should reproduce and triage each report before scheduling work.

## Confirmed / high priority

- [Review UI cannot resume agent-interrupt executions](./agent-interrupt-review-resume-409.md) — Confirmed / high: Approve, Edit, and Reject use an incompatible resume path and return HTTP 409.
- [OpenAI Responses tool metadata grows sessions until HTTP 413](./openai-response-tool-metadata-body-growth-413.md) — Confirmed / high: redundant historical tool catalogs grow durable sessions past the Tool Pod request limit.
- [Magenta message schemas are incompatible with Zod 4.5](./magenta-zod-45-discriminator-incompatibility.md) — Confirmed / high: an allowed Zod resolution fails the first model request; exact `4.4.3` works.
- [Magenta drops MCP tool annotations](./magenta-drops-mcp-tool-annotations.md) — Confirmed / high: remote MCP safety hints are discarded before application policy can inspect them.
- [Mutative tool policy fails open on catalog drift](./mutative-tool-policy-fails-open-on-catalog-drift.md) — Confirmed policy defect / high: newly discovered tools are exposed without an explicit effect classification.
- [Playground renders successful agent suspension as an error](./playground-renders-successful-agent-suspension-as-error.md) — Confirmed / high: the UI simultaneously presents failure and awaiting-review states.

## Confirmed / DX

- [Agent manifest schema and TypeScript deployment guidance are hard to discover](./agentic-manifest-schema-and-typescript-deploy-doc-gaps.md) — Confirmed DX / medium: schema and end-to-end TypeScript deployment guidance require trial and cross-source investigation.
- [Agentic `--no-log` still attempts to open a log file](./agentic-no-log-still-opens-log-file.md) — Confirmed CLI defect / low-medium: disabled logging still emits filesystem permission noise.
- [Agentic dev logs cannot select a bounded log window](./agentic-dev-logs-lacks-bounded-window-options.md) — Confirmed feature gap / low-medium: routine tail, time-window, follow, and timestamp controls are absent.
- [Agentic dev exposes the UI before the stack is ready](./agentic-dev-readiness-and-hot-reload-downtime.md) — Confirmed readiness DX / medium: requests can reach an unavailable stack during startup and reload.
- [Local OE continuously exports traces to an absent OTLP collector](./local-oe-otlp-exporter-log-spam.md) — Confirmed local defect / medium: repeated connection failures obscure useful logs.
- [Tool Pod skill roots depend on import order](./tool-pod-skill-roots-depend-on-import-order.md) — Confirmed local integration defect / medium: bundled skills fail unless the work directory is set before Magenta imports.
- [TypeScript dev runner ignores the declared package manager](./typescript-dev-runner-ignores-declared-package-manager.md) — Confirmed runner defect / medium-high: local reloads use npm instead of the declared pnpm graph.
- [Magenta TypeScript git packages are fragile to consume with pnpm](./magenta-typescript-sdk-packaging-pnpm-friction.md) — Confirmed packaging friction / medium: git subpackages require broad install policy and type workarounds.
- [Prompt confirmation deadlocks runtime HITL](./prompt-confirmation-deadlocks-runtime-hitl.md) — Confirmed app/template integration issue / medium: duplicate approval instructions prevent the protected tool call from being emitted.
- [Playground suppresses actionable backend errors](./playground-suppresses-actionable-backend-errors.md) — Confirmed for review submission / medium: explicit OE guidance is replaced by a generic retry message.
- [Suspended-session composer allows conflicting invocations](./suspended-session-composer-allows-conflicting-invocations.md) — Confirmed UI/backend conflict / medium: an enabled composer sends an invocation that OE rejects with HTTP 409.

## Design risk or needs reproduction

- [Aggregate write stages bypass tool-level HITL](./aggregate-write-stages-bypass-tool-level-hitl.md) — Design risk / high: application policy does not inspect `$out` or `$merge`; Managed MCP execution behavior needs reproduction.
- [Automatic mutation retry can duplicate ambiguous writes](./automatic-mutation-retry-can-duplicate-ambiguous-writes.md) — Design risk / high: unknown-outcome mutation errors are returned with unconditional retry guidance.
- [Deep-agent shell default exposes Tool Pod secrets](./deep-agent-shell-default-exposes-tool-pod-secrets.md) — Design risk / high: shell and credentials share a security domain; no exfiltration test was performed.
- [Atlas MCP cloud bootstrap needs startup secrets and egress](./atlas-mcp-cloud-bootstrap-startup-secret-egress-blockers.md) — Mitigated in Atlas Explorer by replacing runtime bootstrap with pre-provisioned MCP credentials.
- [Atlas MCP identities accumulate across process restarts](./atlas-mcp-identities-leak-across-process-restarts.md) — Mitigated in Atlas Explorer by reusing a pre-provisioned MCP identity; existing generated identities still need cleanup.

## Existing incident context

- [Atlas MCP service-account secret limit](../mcp-secret-limit-incident.md) — Related incident context: losing a one-time local secret while reusing one MCP configuration exhausted its two-secret limit; distinct from per-process configuration churn.
