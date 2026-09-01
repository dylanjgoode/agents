# Bug: Tool Pod skill roots depend on import order

## Summary

**Status: confirmed locally.**

Deep-agent skills were discoverable in the bundle but unreadable at runtime,
failing with `ENOENT`, unless `AGENTIC_AGENT_WORKDIR` was set before importing
the Magenta TypeScript modules.

The Tool Pod filesystem implementation snapshots its allowed skill roots at
module load. A normal static import runs before application initialization can
set the work directory, so setting the environment variable afterward is too
late. Atlas Explorer had to replace the static Magenta import with a dynamic
import ordered after the environment assignment.

This hidden import-order contract creates fragile behavior across local
execution, bundles, test runners, and deployed entrypoints.

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

1. Configure a deep agent with `skills: ["skills"]` and bundled skill
   directories under the agent root.
2. Import `App` or `MagentaToolPodBackend` statically at module top level.
3. Set `AGENTIC_AGENT_WORKDIR` during later application initialization.
4. Start the agent and ask it to load a bundled `SKILL.md`.
5. Observe a filesystem `ENOENT` or unreadable skill path even though the file
   exists in the bundle.
6. Restart with `AGENTIC_AGENT_WORKDIR` set before dynamically importing the
   Magenta module.
7. Observe that the same skill path becomes readable through the audited
   filesystem backend.

## Actual behavior

Skill readability depends on whether the environment variable exists at the
instant the Magenta module is evaluated. Files added correctly to the bundle
can still appear missing because the allowed roots were computed from an
earlier or incorrect working directory.

Atlas Explorer currently uses:

```text
process.env.AGENTIC_AGENT_WORKDIR ||= process.cwd();
const { App, MagentaToolPodBackend } = await import(...);
```

The dynamic import is required for ordering, not merely style.

## Expected behavior

Skill roots should be supplied explicitly by the runner/backend or resolved
when the backend handles a request. Correctly bundled skills should not depend
on JavaScript module evaluation order, and startup should fail clearly if the
configured root is missing or unreadable.

## Evidence

- The migration initially produced `ENOENT` while attempting to read bundled
  skills.
- `main.ts` comments that the Tool Pod snapshots read-only skill roots while
  Magenta modules load.
- The code sets `AGENTIC_AGENT_WORKDIR` before a top-level dynamic import of
  `@magenta/magenta-sdklanggraph-ts`.
- `main.test.ts` deletes the environment variable before importing `main`,
  then verifies that it equals `process.cwd()` when `App` is constructed.
- `skills.test.ts` separately proves that all expected skill directories and
  `SKILL.md` files exist in the source bundle, ruling out a missing source file
  as the observed cause.
- The deep agent passes `skills: ["skills"]` and the Magenta Tool Pod backend,
  so runtime root resolution determines whether those files are usable.

## Root cause

The filesystem/skill root is derived from mutable process environment during
module initialization and cached in module-level state. ECMAScript static
imports are evaluated before the importing module's body, which prevents that
body from establishing the required variable in time.

The runner does not guarantee the environment variable before user-module
evaluation, and the backend does not validate or lazily recompute the root.
The application therefore has to know and satisfy an undocumented temporal
coupling.

## Impact

- Bundled skills fail at runtime despite passing package/content tests.
- Refactoring a dynamic import back to a static import silently regresses
  behavior.
- Test and production loaders can differ based on module cache and import
  order.
- Error messages report `ENOENT`, directing investigation toward packaging
  rather than root initialization.
- Any other module that imports Magenta first can freeze the wrong roots before
  the application workaround runs.

## Suggested fix

Prefer one of these platform-owned solutions:

1. Have the runner set `AGENTIC_AGENT_WORKDIR` before loading any user or
   Magenta module.
2. Pass the agent/skills root explicitly to `MagentaToolPodBackend`.
3. Resolve and validate roots lazily when constructing the backend or handling
   the first filesystem request.

In all cases, add startup validation that checks the resolved root and expected
skills directory, then reports the resolved nonsecret path and remediation.
Avoid module-level snapshots of mutable environment where possible.

## Acceptance criteria

- Static and dynamic import forms resolve the same skill root.
- A correctly bundled `SKILL.md` is readable without application-specific
  import choreography.
- The runner establishes the work directory before user-module evaluation, or
  the backend accepts it explicitly.
- Missing or unreadable roots fail at startup with an actionable error rather
  than a later generic `ENOENT`.
- Tests cover unset, preset, invalid, relative, and deployed work directories.
- Module cache/import order does not change the allowed roots.
- Filesystem access remains constrained to approved roots.

## Workaround

Set `AGENTIC_AGENT_WORKDIR` before any Magenta import and use a dynamic import,
as Atlas Explorer currently does. Ensure no earlier dependency imports the
Magenta module first, and retain a test that records the value seen during
`App` construction.
