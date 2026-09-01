# Design risk: Deep-agent shell default exposes Tool Pod secrets

## Summary

**Status: design risk; no secret-exfiltration exploit performed.**

The default `MagentaToolPodBackend` implements deep-agent shell execution, and
Deep Agents advertises that capability as `execute`/`shell_execute`. The same
Tool Pod contains invocation credentials and an OAuth token cache needed by
tools.

Filesystem handlers can restrict readable roots, but a general-purpose shell
running in the Tool Pod process/container is a materially different boundary:
it can potentially access process environment, process-visible files, and
other container resources outside the audited filesystem handler's roots.

Atlas Explorer required two application mitigations: filtering
`shell_execute` from model-visible tools and proxying the backend so its
`execute` method is absent. No command was used to read or transmit a secret,
so this report does not claim demonstrated credential disclosure.

## Environment

- Agentic CLI: `0.1.84-alpha` (`5c52c8f48`)
- Runner image: `runner-base-typescript-langgraph:0.1.84-alpha`
- Playground UI: `playground-ui:0.1.84-alpha`
- Orchestration engine: `0.0.73`
- LangChain: `1.5.10`
- Deep Agents: `1.13.2`
- Magenta TypeScript Tool Pod backend
- Local Docker development stack on macOS

## Reproduction

This design exposure can be reproduced without accessing credentials:

1. Construct a deep agent with an unmodified
   `new MagentaToolPodBackend()`.
2. Inspect the backend and generated deep-agent tool catalog.
3. Confirm that the backend has an `execute` method and that shell execution is
   represented to the agent as `execute` or `shell_execute`.
4. Inspect Tool Pod configuration and confirm that invocation-scoped
   credentials and OAuth state are present in the same workload.
5. Apply only the model-visible name filter and observe that the backend still
   has `execute`.
6. Apply only the backend proxy and observe that catalog-level filtering is
   still needed where `shell_execute` is independently discovered.

Do not run environment-dumping, filesystem-search, cache-reading, or outbound
exfiltration commands in a credentialed Tool Pod.

## Actual behavior

The default backend provides general-purpose command execution in the same
security domain as Tool Pod secrets. Atlas Explorer must explicitly:

- remove `shell_execute` in `selectAtlasTools`, and
- wrap `MagentaToolPodBackend` with `withoutShellExecution`, whose proxy hides
  the `execute` property from reads, membership checks, and property
  descriptors.

The deep-agent filesystem methods remain available through the audited Tool
Pod path.

## Expected behavior

General-purpose shell execution should be disabled unless the application
explicitly opts in. Enabling it should not place unrelated tool credentials,
OAuth caches, or platform control credentials within the shell's readable
security boundary.

## Evidence

- `main.ts` constructs `MagentaToolPodBackend` and immediately wraps it with
  `withoutShellExecution`.
- `agentBackend.ts` states that Tool Pod credentials and OAuth cache files live
  outside filesystem-handler roots but that unrestricted shell execution in
  the same container could reach them.
- `agentBackend.test.ts` verifies that audited filesystem methods remain while
  `execute` is absent and never called.
- `agentPolicy.ts` separately filters the bare name `shell_execute`.
- `main.test.ts` verifies that the backend passed to `deepAgent` has no
  `execute` property.
- The README documents that the model is not given general-purpose shell
  execution because credential files are outside the filesystem sandbox.

No secret value was read, printed, or transmitted during validation.

## Root cause

The backend's default capability set couples two concerns:

1. audited file operations needed by skills, and
2. arbitrary command execution.

At the same time, Tool Pod isolation is being used to host credentialed tool
execution. Filesystem-root restrictions do not constrain a shell unless the
shell itself runs in a separate sandbox with an independently minimized
environment and filesystem.

The need for both a catalog filter and a backend proxy also indicates that
capability advertisement is not controlled by one explicit application
setting.

## Impact

- Prompt injection or model error could potentially turn shell access into
  credential access.
- OAuth access tokens or invocation secrets could potentially be reused within
  their validity and scope.
- Application developers must know to add multiple mitigations.
- A framework or naming change could re-advertise shell execution despite one
  of the filters.

These are design-level consequences. Actual credential readability,
exfiltration, and token reuse were not tested.

## Suggested fix

1. Make shell execution an explicit, documented opt-in for deep agents.
2. Default the backend to audited filesystem operations only.
3. Keep tool credentials and OAuth caches out of any shell-enabled sandbox.
4. If shell is enabled, run it in a separate container or sandbox with a
   minimal environment, constrained filesystem, restricted network, and no
   inherited tool credentials.
5. Generate the advertised tool set from the enabled backend capabilities so
   one setting controls both `execute` and `shell_execute`.
6. Add startup diagnostics that identify shell enablement without exposing
   secret values.

## Acceptance criteria

- A default deep agent does not advertise or implement shell execution.
- Enabling filesystem tools does not implicitly enable a shell.
- Shell requires an explicit application opt-in.
- A shell-enabled sandbox has no unrelated Tool Pod credentials or OAuth cache
  mounted or inherited.
- Catalog and backend capability tests cannot disagree about shell
  availability.
- Regression tests cover `get`, `has`, descriptors, and generated tool names.
- Security validation uses synthetic canary values, not production
  credentials.

## Workaround

Filter `shell_execute` from discovered tools and pass a backend that does not
expose `execute`, as Atlas Explorer currently does. Keep the Tool Pod
filesystem handler's readable roots narrow and avoid enabling any alternate
command-execution tool.
