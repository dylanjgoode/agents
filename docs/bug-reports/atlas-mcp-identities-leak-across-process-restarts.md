# Bug: Atlas MCP identities leak across process restarts

## Summary

**Status: creation-on-restart is confirmed in code and local process behavior;
the resulting remote-resource count needs a retained Atlas inventory
reproduction.**

**Mitigation:** Atlas Explorer now consumes a manually provisioned Managed MCP
identity instead of creating one during each process start. Restarts reuse the
configured identity, eliminating further configuration churn. Existing
`atlas-explorer-*` identities still require operator review and cleanup.

Atlas Explorer creates a new UUID-named Atlas organization MCP configuration
and a one-year client secret every time its module starts in a runtime process.
Both the Agent Execution Runtime (AER) and Tool Pod evaluate the module, so one
local stack start or hot reload can create two remote identities.

The session recorded ten source-triggered reloads, and both AER and Tool Pod
were observed running the startup path. The current code therefore creates up
to two Atlas MCP configurations and secrets per reload in that two-process
topology. Process exit, crash, and reload have no matching cleanup path, so
created `ORG_OWNER` identities are not reclaimed by the application.

This is distinct from the two-secret-per-service-account incident documented
in [Atlas MCP service-account secret
limit](../mcp-secret-limit-incident.md). That incident stacked secrets on one
reused MCP configuration. This report concerns lifecycle churn that creates a
new configuration and service-account identity on every process start.

## Environment

- Agentic CLI: `0.1.84-alpha` (`5c52c8f48`)
- Runner image: `runner-base-typescript-langgraph:0.1.84-alpha`
- Playground UI: `playground-ui:0.1.84-alpha`
- Orchestration engine: `0.0.73`
- LangChain: `1.5.10`
- Deep Agents: `1.13.2`
- Atlas Admin API and Atlas Managed MCP
- Local Docker development stack with hot reload on macOS

## Reproduction

1. Configure Atlas Explorer with Atlas Admin API credentials authorized to
   create organization MCP configurations.
2. Record the existing Atlas MCP configurations whose names begin with
   `atlas-explorer-`.
3. Start the local stack and allow both AER and Tool Pod processes to evaluate
   the agent module.
4. Trigger ten code-watcher restarts or equivalent hot reloads.
5. List MCP configuration metadata through an authorized administrative
   interface.
6. Count newly created `atlas-explorer-<uuid>` configurations and associated
   secret metadata.
7. Stop the local stack and list the resources again.

Do not include client IDs, secret values, organization IDs, or access-list
addresses in captured evidence.

## Actual behavior

Each process start performs this sequence:

1. resolve public IPv4,
2. generate a UUID,
3. create an `atlas-explorer-<uuid>` MCP configuration with `ORG_OWNER`,
4. create a secret with a one-year expiry, and
5. retain the one-time secret only in process memory.

There is no reuse across process restarts and no shutdown cleanup. In the
observed two-process topology, each reload can run the top-level bootstrap in
both AER and Tool Pod. A sanitized before/after Atlas inventory is still needed
to establish the exact remote-resource count for the ten recorded reloads.

## Expected behavior

Development reloads and routine process restarts should not create unbounded
remote privileged identities. Runtime identities should have an explicit
owner, bounded lifetime, reuse or lease semantics where safe, and deterministic
reconciliation or cleanup.

## Evidence

- `main.ts` calls `prepareAtlasMcpEnvironment()` at module top level.
- `startup.ts` documents that AER and Tool Pod evaluate the module
  independently and memoizes only within one process.
- `bootstrap.ts` generates a fresh UUID for every call and creates an org MCP
  configuration named `atlas-explorer-<uuid>`.
- The creation body assigns `roles: ["ORG_OWNER"]`.
- `SECRET_EXPIRES_AFTER_HOURS` is `8760`, or one year.
- The bootstrap implementation contains create requests but no delete,
  revoke, lease-renewal, or remote-reconciliation path.
- The README states that stopped or crashed processes cannot delete their
  remote configuration and instructs operators to remove stale configurations.
- The session recorded ten source-reload events and observed both runtime
  processes using the startup path.

The code-confirmed creation path does not need credential values as evidence.
The exact number of resulting remote resources should be confirmed separately
with nonsecret Atlas metadata.

## Root cause

Process lifetime is used as identity lifetime, but only identity creation is
implemented. The UUID strategy intentionally avoids sharing the
two-secret-per-service-account cap, yet it moves the lifecycle problem one
level up: every restart creates a new configuration/service account.

Process-local promise memoization prevents duplicate creation only among
concurrent callers in the same module instance. It does not survive reloads,
new containers, AER/Tool separation, crashes, or deployments.

## Impact

- Privileged `ORG_OWNER` identities accumulate in the Atlas organization.
- One-year secrets outlive the workloads that requested them.
- Administrative inventory becomes noisy and ownership is hard to determine.
- Revocation becomes manual and risks deleting an identity still in use.
- Hot reload can create up to two identities per reload in the observed
  two-process topology.
- Horizontal scaling and crash loops can multiply the same lifecycle issue.

## Suggested fix

Introduce a platform-owned identity lifecycle rather than unconditional
top-level creation:

1. Assign stable workload-instance or deployment ownership metadata where the
   supported Atlas API permits it, including creation time and purpose in the
   name if metadata is unavailable.
2. Reuse a still-valid identity only when ownership can be proven.
3. Reconcile stale identities at controlled startup or through an operator
   job.
4. Revoke identities after a bounded grace period, not from an unreliable
   process-exit handler alone.
5. Use the least-privileged Atlas roles required by exposed tools.
6. Make expiry substantially shorter where rotation and runtime behavior
   permit.
7. Expose nonsecret inventory and cleanup guidance to operators.

Cleanup must never delete by prefix alone without checking ownership and
active use.

## Acceptance criteria

- Repeated hot reloads do not create an unbounded number of MCP
  configurations.
- AER and Tool Pod do not independently create identities unless both truly
  require them.
- Every created identity has a traceable workload/deployment owner without
  exposing secrets.
- Crash and abandoned-deployment identities are reconciled after a documented
  grace period.
- Cleanup refuses ambiguous or currently active identities.
- Default roles are least privilege rather than unconditional `ORG_OWNER`.
- Tests cover restart, two-process startup, crash/retry, and horizontal-scale
  scenarios.
- The two-secret cap incident remains documented as a separate failure mode.

## Workaround

Periodically inventory `atlas-explorer-*` MCP configurations, correlate them
with active workloads using nonsecret metadata, and explicitly revoke only
confirmed stale identities. Reduce development hot reloads when using live
Atlas bootstrap, and use a dedicated nonproduction organization with
least-privileged credentials.
