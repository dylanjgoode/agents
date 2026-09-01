# Bug: Local OE continuously exports traces to an absent OTLP collector

## Summary

**Status: confirmed local-development defect.**

The default local orchestration engine attempted to post traces to
`https://localhost:4318/v1/traces` approximately every five seconds, while the
generated Agentic development stack included no collector at that address.
Each attempt produced a connection-refused error.

Dozens of identical failures obscured application and orchestration errors
during a short migration session.

## Environment

- Agentic CLI: `0.1.84-alpha` (`5c52c8f48`)
- Runner image: `runner-base-typescript-langgraph:0.1.84-alpha`
- Orchestration engine: `0.0.73`
- Default local Docker development stack on macOS
- No user-configured OTLP collector

## Reproduction

1. Start an agent with the default local Agentic development stack.
2. Do not run an OTLP HTTP collector on port 4318.
3. Inspect orchestration-engine logs for several minutes.
4. Count trace export failures and their interval.

## Actual behavior

OE repeatedly attempts:

```text
https://localhost:4318/v1/traces
```

The connection is refused, and a near-identical error is logged about every
five seconds. In one approximately five-minute sample, 44 trace-export
connection failures were counted. Another sample contained 26.

## Expected behavior

For the default local stack, one of the following should hold:

- telemetry export is disabled;
- a compatible collector is included and healthy;
- an explicitly configured external collector is used; or
- an absent optional collector produces one diagnostic and exponential
  backoff rather than continuous error-level noise.

## Evidence

Evidence comes from OE logs captured during the Atlas Explorer migration and a
targeted count performed during the independent local-DX audit.

- The destination was `https://localhost:4318/v1/traces`.
- Failures recurred at an approximately five-second cadence.
- A five-minute sample contained 44 failures.
- The generated development Compose file did not define an OTLP collector
  service or an observed override to a reachable collector.

The raw error line is not copied into this report because the captured audit
retained the destination, cadence, and counts rather than one canonical full
stack trace.

## Root cause

OE's local configuration enables an OTLP exporter by default, but the generated
development topology does not satisfy that default. The retry loop uses a
short, fixed interval and logs every failure.

There may also be an address-scope issue: inside a container, `localhost`
refers to that container, not a collector on the host or another service.

## Impact

- Real runtime failures are harder to find in OE logs.
- Log capture grows continuously while idle.
- Developers may investigate telemetry instead of the request failure they
  intended to debug.
- Repeated connection attempts waste local resources.
- Error monitoring can report a permanently unhealthy local stack.

## Suggested fix

1. Disable OTLP export in local development unless explicitly enabled.
2. Alternatively, add a collector service and address it by Compose service
   name over the correct protocol.
3. Validate the endpoint once at startup.
4. On optional-export failure, log once, back off exponentially, and emit a
   recovery message when export resumes.
5. Include telemetry status in `agentic dev status`.
6. Document the environment variable or manifest setting that controls local
   export.

## Acceptance criteria

- A default local stack with no collector produces no recurring OTLP errors.
- An opted-in collector receives traces successfully.
- A misconfigured optional endpoint logs one actionable diagnostic and backs
  off.
- The log names the configured endpoint and how to disable or configure it.
- Application/OE errors remain visible without telemetry noise.

## Workaround

Disable the local exporter using the supported OE configuration if available,
or run a collector reachable from the OE container and set the endpoint
explicitly. Filtering the repeated message helps log review but does not stop
the retries.
