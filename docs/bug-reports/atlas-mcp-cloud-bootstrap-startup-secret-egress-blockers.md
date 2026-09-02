# Deployment blocker: Atlas MCP cloud bootstrap needs startup secrets and egress

## Summary

**Status: deployment-readiness design blocker derived from CLI/config
investigation; remote build and deploy not yet reproduced.**

**Mitigation:** Atlas Explorer now uses a manually provisioned Managed MCP
client ID and secret supplied to AER and Tool Pods. Runtime Atlas Admin API
bootstrap and public-IP discovery are no longer part of application startup;
Magenta performs only the OAuth token exchange and MCP connection.

Atlas Explorer performs Atlas MCP identity bootstrap and MCP tool discovery at
module startup. The same top-level module is evaluated in both AER and Tool Pod
processes.

The investigated cloud contract exposes tool secrets at invocation scope,
while this bootstrap needs Atlas Admin API credentials before an invocation
exists. In addition, AER performs MCP discovery during `App` construction, but
the manifest grants `mcp.mongodb.com` egress only to the Tool component.

Those timing and network-boundary assumptions are incompatible unless the
platform supplies equivalent startup-scoped secrets/egress through a supported
mechanism. No remote image build or deployment was completed to confirm the
exact failure response, so this report does not claim a specific production
error code or log message.

## Environment

- Agentic CLI: `0.1.84-alpha` (`5c52c8f48`)
- Runner image: `runner-base-typescript-langgraph:0.1.84-alpha`
- Playground UI: `playground-ui:0.1.84-alpha`
- Orchestration engine: `0.0.73`
- LangChain: `1.5.10`
- Deep Agents: `1.13.2`
- Atlas Admin API, OAuth client credentials, and Atlas Managed MCP
- Cloud behavior assessed from Agentic CLI and manifest/config investigation

## Reproduction

The design mismatch can be inspected without deploying:

1. Read `main.ts` and confirm that `prepareAtlasMcpEnvironment()` runs before
   constructing `App`.
2. Read `startup.ts` and confirm that both AER and Tool Pod processes evaluate
   this module independently.
3. Read `bootstrap.ts` and list startup dependencies:
   `ATLAS_ORG_ID`, `ATLAS_PUBLIC_API_KEY`, `ATLAS_PRIVATE_API_KEY`, Atlas Admin
   API egress, and public-IPv4 discovery egress.
4. Read `agent.yaml` and compare those needs with its secret declarations and
   component-scoped network policy.
5. Confirm from the investigated CLI/config contract that cloud tool secrets
   are provided for tool invocation rather than arbitrary module startup.
6. Confirm that `mcp.mongodb.com` is configured with `component: tool` while
   AER constructs `App` and performs MCP discovery.

To complete reproduction, build and deploy the unchanged manifest to a
nonproduction workspace, capture sanitized AER and Tool Pod startup logs, and
record the first failing boundary. That remote test has not been run.

## Actual behavior

The current application assumes startup can:

- read Atlas Admin API secrets in both AER and Tool processes,
- contact public IPv4 services from both processes,
- call `cloud.mongodb.com` from both processes,
- create an MCP identity in each process,
- inject generated client credentials into process environment, and
- let AER perform MCP discovery against `mcp.mongodb.com`.

The investigated cloud secret and egress model does not establish those
capabilities at the required time and in the required component. Therefore the
manifest is not deployment-ready even though the local Docker environment
provides process environment and broad enough networking.

## Expected behavior

Cloud deployment should have a documented, supported bootstrap path in which:

- credentials are available only to the component and lifecycle phase that
  needs them,
- MCP discovery occurs in a component allowed to reach the MCP endpoint,
- generated credentials can be passed to the consumer without entering model
  context or logs, and
- process scaling does not create unbounded Atlas identities.

## Evidence

- `main.ts` awaits `prepareAtlasMcpEnvironment()` at top level before
  `new App(...)`.
- `startup.ts` states that AER and Tool Pod each evaluate the module and
  memoizes bootstrap only within one process.
- `bootstrap.ts` immediately reads three `ATLAS_*` Admin API values and makes
  outbound calls before application construction finishes.
- `agent.yaml` declares the Atlas Admin API values for AER and for
  `mongodb__*` tool invocations, but declaration does not itself prove
  startup-time availability in the Tool Pod.
- The same manifest grants `cloud.mongodb.com` and public-IP hosts to all
  components but grants `mcp.mongodb.com` only to `component: tool`.
- Application logging says `App` discovers MCP tools from `agent.yaml`; that
  construction occurs in AER startup.
- The CLI/config investigation found tool secrets to be invocation-scoped,
  which is later than top-level module bootstrap.
- The current bootstrap creates one UUID-named `ORG_OWNER` configuration and
  one one-year secret per process.

No remote build/deploy logs exist yet, so the exact runtime symptom remains
**needs reproduction**.

## Root cause

The local implementation combines four lifecycle phases in user-module
startup:

1. acquire administrative secrets,
2. provision a remote MCP identity,
3. exchange/configure credentials, and
4. discover MCP tools.

The cloud platform separates AER and Tool components and scopes secrets and
network destinations by component and invocation. The application assumes
local process-environment semantics across those boundaries.

Because both processes execute the same module, simply granting broader access
would also create duplicate identities and amplify the restart leak.

## Impact

- Remote startup may fail before the app becomes healthy.
- Failure can occur from missing startup credentials, blocked MCP discovery,
  or both.
- Broadening all-component secrets and egress would weaken isolation.
- If both processes are enabled successfully, each replica/process can create
  a separate `ORG_OWNER` identity and one-year secret.
- Horizontal scaling, retries, and crash loops increase identity count.
- Local success is not evidence of cloud deployability.

## Suggested fix

Choose a lifecycle that aligns with supported platform boundaries. Viable
design alternatives include:

1. Provision the MCP identity outside runtime startup, then inject its
   credentials through a platform-supported startup secret mechanism if one
   exists.
2. Move identity creation and MCP connection/discovery into the Tool
   component, where invocation-scoped secrets and MCP egress are available,
   and expose only the resulting tools across the existing platform boundary.
3. Add a platform bootstrap phase with explicit startup-scoped secrets,
   constrained egress, secure credential handoff, and ownership/cleanup.
4. Use a stable, externally managed MCP identity with rotation and
   reconciliation when per-process identities are not required.

These are architectural alternatives, not claims that a particular currently
unsupported API exists. Do not solve the mismatch by placing Admin API secrets
and MCP egress in every component without a threat-model review.

## Acceptance criteria

- A remote nonproduction build and deploy completes with sanitized evidence.
- AER startup does not require invocation-only tool secrets.
- The component performing MCP discovery has explicit egress to
  `mcp.mongodb.com`.
- Atlas Admin API secrets are available only during an approved lifecycle
  phase and never enter model context or logs.
- AER and Tool Pod do not independently provision duplicate identities unless
  explicitly designed to do so.
- Replica scaling and restart tests show bounded identity creation.
- Failed startup leaves no unreconciled privileged identity, or a documented
  reconciler removes it safely.
- Network and secret declarations match observed component behavior.
- Documentation names the supported provisioning, rotation, and cleanup
  owner.

## Workaround

Continue local validation only, or pre-provision and manage MCP credentials
outside the deployed process using an already supported secret-delivery path.
Before remote deployment, verify startup secret timing and component egress
with the platform owner. Do not broaden secret or network scope speculatively.
