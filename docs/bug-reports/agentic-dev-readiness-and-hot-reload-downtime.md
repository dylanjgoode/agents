# DX: Agentic dev exposes the UI before the stack is ready

## Summary

**Status: confirmed misleading readiness; normal startup and reload downtime
are not themselves defects.**

`agentic dev up` made the playground URL available and returned control before
the orchestration engine and agent runtime were ready to serve requests. During
initial startup and source-triggered restarts, the UI remained callable while
OE or AER was unavailable. The migration observed connection-refused responses,
proxy HTTP 502s, and a user request arriving during a restart.

Brief unavailability while processes start is normal. The DX defect is that
command completion and an accessible UI imply readiness without gating request
dispatch or clearly showing a restarting state.

## Environment

- Agentic CLI: `0.1.84-alpha` (`5c52c8f48`)
- Runner image: `runner-base-typescript-langgraph:0.1.84-alpha`
- Orchestration engine: `0.0.73`
- Local Docker development stack on macOS
- TypeScript agent with network-dependent startup bootstrap

## Reproduction

1. Configure a TypeScript agent whose startup takes several seconds.
2. Remove one required local secret, or start from a cold local stack.
3. Run `agentic dev up`.
4. Open the printed playground URL as soon as it is available.
5. Send a request before OE and AER readiness is established.
6. Restore configuration and wait for a healthy stack.
7. Edit a watched source file.
8. Send another request while the supervisor rebuilds and restarts AER/Tool.

## Actual behavior

- The UI becomes reachable before all request-path services are ready.
- `agentic dev up` can complete even when the app later fails from a missing
  required secret.
- UI proxy attempts during an OE gap return connection errors or HTTP 502.
- Requests during source reload can reach a temporarily closed AER port.
- The playground does not consistently present a dedicated starting or
  restarting state before dispatch.

One captured restart window produced connection-refused behavior; another log
sample contained six proxy failures. The evidence does not establish that
requests were lost after acceptance, only that users could submit while the
request path was unavailable.

## Expected behavior

- `agentic dev up` should either wait for usable readiness or explicitly state
  that startup continues asynchronously.
- The CLI should preflight locally required secret names before starting.
- The UI should health-gate dispatch and display starting/restarting status.
- Hot reload should drain or reject requests before process shutdown with an
  actionable retry signal.
- Liveness and readiness should remain distinct.

## Evidence

Evidence comes from the migration transcript, generated Compose configuration,
service health checks, and UI/OE logs.

- The command completed before later service logs established readiness.
- The first stack attempt started without required Atlas environment values and
  then failed inside the application.
- During a restart, a request briefly encountered `connection refused`.
- UI logs showed backend proxy failures and 502 responses while OE was
  unavailable.
- The migration repeatedly used explicit Docker health loops because command
  completion was not sufficient evidence that the app could accept requests.

The logs do not preserve every raw timestamp in the report source. The audit
reconstructed one approximately 14-second backend-unavailable window, but this
report does not assert a universal startup duration.

## Root cause

Container start, service liveness, application readiness, and UI availability
are treated as different asynchronous events without one user-facing readiness
contract. The UI can run independently of OE, and the source supervisor stops
and starts AER/Tool processes in place while the UI remains available.

Required secret names are available in `agent.yaml`, but local startup does not
reject missing values before bringing up the broader stack.

## Impact

- Developers receive 502/connection errors during otherwise normal lifecycle
  transitions.
- Missing configuration is discovered late in container logs.
- Failed requests can be mistaken for application bugs.
- Users may retry mutative requests without knowing whether dispatch occurred.
- Scripts must implement their own readiness polling.

## Suggested fix

1. Add a startup preflight for all locally required secret names; never print
   values.
2. Make `dev up` wait for OE, AER, and Tool readiness with a bounded timeout.
3. Print failing service names and short log excerpts on timeout.
4. Offer `--no-wait` for callers that want current asynchronous behavior.
5. Expose one aggregate readiness endpoint to the playground.
6. Disable submission or queue it intentionally while the stack is starting or
   restarting.
7. During hot reload, mark not-ready before stopping listeners and return a
   clear retryable status.

## Acceptance criteria

- Missing required secrets fail before containers are reported ready.
- Successful `dev up` means a harmless request can reach OE and AER.
- `--no-wait` clearly reports that readiness has not been established.
- The playground shows a starting/restarting state and does not dispatch into
  unavailable services.
- Hot-reload requests receive either a deliberate queue result or a
  deterministic retryable response, not a generic 502.
- Health timeout output identifies the failing component.

## Workaround

Before sending requests, check all required local secret names and wait for
service health explicitly. During source reload, wait until AER and OE are
healthy again before using the playground.

Treat transient connection refusal during an observed restart as lifecycle
downtime, not proof of an application defect.
