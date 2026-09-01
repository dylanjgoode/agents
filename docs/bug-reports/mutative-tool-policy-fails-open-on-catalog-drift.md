# Bug: Mutative tool policy fails open on catalog drift

## Summary

**Status: confirmed policy behavior; omissions were found during migration.**

Atlas Explorer protects mutations with a hard-coded allowlist of exact tool
names. At the same time, `selectAtlasTools` exposes every discovered tool by
default except `atlas_local_*` and `shell_execute`.

This combination fails open when the Managed MCP catalog adds or renames a
mutative tool: the unknown tool is available to the model but is absent from
HITL until application code and tests are updated. During the migration,
multiple real omissions had to be added after initial policy construction,
first across database/Atlas infrastructure coverage and then for
`mongodb__atlas_streams_build`.

## Environment

- Agentic CLI: `0.1.84-alpha` (`5c52c8f48`)
- Runner image: `runner-base-typescript-langgraph:0.1.84-alpha`
- Playground UI: `playground-ui:0.1.84-alpha`
- Orchestration engine: `0.0.73`
- LangChain: `1.5.10`
- Deep Agents: `1.13.2`
- Atlas Managed MCP dynamic tool discovery
- Local Docker development stack on macOS

## Reproduction

1. Add a synthetic discovered tool such as
   `mongodb__future_mutating_operation` to the `selectAtlasTools` input.
2. Do not add that name to `MUTATIVE_MCP_INTERRUPT_ON`.
3. Build the agent with the selected catalog.
4. Confirm that the synthetic tool remains in the model-visible tools.
5. Confirm that the HITL `interruptOn` configuration has no entry for it.

The same behavior occurs naturally if a remote MCP catalog introduces a new
mutation between application releases.

## Actual behavior

Unknown names are exposed by default and treated as unprotected by the
application's exact-name policy. The selection test makes this behavior
explicit: `custom_read_only_tool` is retained without any classification
metadata or policy review.

The runtime does not fail startup when:

- a discovered tool has no known mutability classification,
- a protected allowlist entry no longer exists in the catalog, or
- a newly discovered write tool is not in the allowlist.

## Expected behavior

Every discovered tool should have a trusted, explicit mutability
classification before it becomes model-visible. Unknown or conflicting
classifications should fail closed, preferably at startup with an actionable
catalog diff.

## Evidence

- `MUTATIVE_MCP_INTERRUPT_ON` is a hand-maintained
  `Record<string, true>` keyed by exact sanitized MCP names.
- `selectAtlasTools` returns all names except two negative filters:
  `atlas_local_*` and `shell_execute`.
- The policy test confirms that an arbitrary
  `custom_read_only_tool` passes through selection.
- Migration commit history shows the initial policy covered database names and
  two Streams lifecycle names but omitted a larger set of Atlas
  infrastructure mutations.
- A later policy update added cluster creation, sample data loading, access
  list creation, database-user creation, project creation, upgrade,
  pause/resume, and `mongodb__atlas_streams_build`.
- The Streams omission is especially concrete: manage and teardown were
  already protected while build, which creates resources, was not.

No claim is made that an omitted tool was used maliciously. The confirmed bug
is fail-open classification and the demonstrated catalog omissions.

## Root cause

Tool selection and tool-effect classification are separate, manually
maintained mechanisms with opposite defaults:

- selection default: allow
- HITL classification default: no interrupt

The code has no authoritative catalog metadata, completeness assertion, or
startup reconciliation tying the two mechanisms together. Exact sanitized
names also make the policy sensitive to server naming and catalog drift.

## Impact

- New or renamed write tools can become callable without application-level
  approval.
- Safety coverage depends on developers repeatedly auditing a dynamic remote
  catalog.
- Tests that compare the allowlist to itself do not prove catalog
  completeness.
- Operators may reasonably but incorrectly infer that all persistent
  mutations are gated.
- Drift can occur without an application code change, making deployment
  behavior dependent on the catalog returned at startup.

## Suggested fix

Prefer trusted mutability metadata attached to tool definitions and consumed
by the runtime policy. The metadata should distinguish read, write, and
argument-dependent tools and should be covered by the MCP/server contract.

If trustworthy metadata is not currently available, add a startup
classification gate:

1. Enumerate every discovered tool.
2. Match each against a reviewed classification manifest.
3. Expose known read-only tools.
4. Route known mutative tools to HITL.
5. Route argument-dependent tools through argument-aware policy.
6. Reject startup or hide unknown tools until explicitly classified.
7. Report added, removed, and renamed catalog entries without logging secrets.

## Acceptance criteria

- Startup cannot expose a tool lacking an explicit classification.
- A synthetic unknown tool is hidden or causes an actionable startup failure.
- A known mutative tool is always configured for HITL before model exposure.
- A known read-only tool remains available without approval.
- Argument-dependent tools cannot be labeled read-only solely by name.
- Catalog additions, removals, and renames produce a clear nonsecret diff.
- Tests reconcile the real discovered catalog against the classification
  manifest.
- Classification source and trust boundary are documented.

## Workaround

Pin and audit the Managed MCP catalog used by each release, compare discovered
names against the checked-in policy at startup, and block deployment when the
sets differ. Until that exists, manually inspect catalog changes and add every
mutation before exposing the updated server.
