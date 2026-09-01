# Bug: Magenta message schemas are incompatible with Zod 4.5

## Summary

**Status: confirmed defect.**

The Magenta TypeScript packages declared `zod: ^4.4.3`. A clean dependency
resolution selected Zod `4.5.4`, and Atlas Explorer's first LLM invocation
failed before model execution with:

```text
Duplicate discriminator value "undefined"
```

The services were otherwise healthy and Managed MCP discovery had completed.
Pinning and overriding the complete dependency graph to exactly Zod `4.4.3`
made the same content-block schema parse and allowed invocation to proceed.

## Environment

- Agentic CLI: `0.1.84-alpha` (`5c52c8f48`)
- Runner image: `runner-base-typescript-langgraph:0.1.84-alpha`
- Orchestration engine: `0.0.73`
- Node.js: 24
- Package managers involved: pnpm for the app; npm in the local dev runner
- Incompatible resolution: Zod `4.5.4`
- Working resolution: Zod `4.4.3`

## Reproduction

1. Create a clean TypeScript project that installs the Magenta SDK packages
   from their git-subdirectory package specifications.
2. Do not add an application-level Zod override.
3. Confirm that the Magenta package metadata permits `zod: ^4.4.3`.
4. Install after Zod `4.5.4` is available and confirm that the resolved runtime
   version is `4.5.4`.
5. Import `MessageSchema` from `@magenta/sdk-core-ts`.
6. Parse a content-block message:

```ts
MessageSchema.parse({
  role: "user",
  content: [{ type: "text", text: "hello" }],
});
```

7. Alternatively, start the local Agentic stack and send the first request
   that invokes the LLM.
8. Repeat with a graph-wide override to exactly `zod: 4.4.3`.

## Actual behavior

With Zod `4.5.4`, construction or use of the content-block discriminated union
throws:

```text
Duplicate discriminator value "undefined"
```

The first end-to-end LLM request fails even though the AER, Tool Pod, and MCP
tool discovery have started successfully.

With an exact `4.4.3` override, the standalone schema regression passes and the
end-to-end request crosses the AER/Tool Pod schema boundary.

## Expected behavior

- Every version allowed by the SDK's Zod range should work with its exported
  schemas.
- A clean install should not select a dependency version that makes the first
  model request fail.
- Message-schema compatibility should be tested at both the minimum and newest
  allowed Zod versions.
- If only one Zod version is supported, package metadata should encode that
  constraint.

## Evidence

Evidence comes from the Atlas Explorer migration transcript, installed package
metadata, the generated lockfile, and a focused `MessageSchema` regression.

- Magenta allowed `^4.4.3`.
- npm resolved Zod `4.5.4`.
- Both runtime processes started and discovered 41 Managed MCP tools before
  the first invocation failed.
- The observed runtime error was
  `Duplicate discriminator value "undefined"`.
- A direct content-block parse reproduced the same schema failure.
- Adding a direct exact dependency was not considered sufficient because a
  transitive Magenta package could still resolve its own compatible-range
  copy.
- A graph-wide exact `4.4.3` override made the focused regression pass and
  unblocked invocation.

The transcript did not preserve the complete original stack trace, so this
report does not claim which Zod internal change introduced the behavior.

## Root cause

The SDK's declared compatibility range is broader than its tested schema
compatibility. Its content-block union relies on discriminator behavior that
differs between the tested `4.4.3` release and the allowed `4.5.4` release.

Package-manager differences amplified the defect: pnpm overrides can hold the
application graph at `4.4.3`, while the generated local runner's npm install
does not consume `pnpm-workspace.yaml`. That runner issue is tracked separately
in [TypeScript dev runner ignores the declared package
manager](./typescript-dev-runner-ignores-declared-package-manager.md).

## Impact

- A newly installed TypeScript agent can fail on its first model invocation.
- Service health and MCP discovery can appear successful, delaying diagnosis.
- Builds are not reproducible across install dates or package managers.
- Every consumer must know and repeat an undocumented exact override.
- The error text describes a discriminator collision, not the incompatible
  dependency resolution that caused it.

## Suggested fix

Short term:

1. Change Magenta package metadata to require exactly `zod: 4.4.3`, or a range
   known not to include the incompatible release.
2. Publish one authoritative lock/override recommendation for all supported
   package managers.
3. Add a compatibility test that parses text and non-text content blocks.

Preferred long term:

1. Rewrite the schema so each union member has an unambiguous, non-defaulted
   literal discriminator under supported Zod 4.x releases.
2. Test the minimum and latest allowed Zod versions in CI.
3. Publish prebuilt Magenta packages with validated dependency constraints.
4. Emit dependency-version context when protocol schema initialization fails.

## Acceptance criteria

- A clean install using package metadata alone can parse Magenta content-block
  messages.
- The first LLM invocation succeeds with the newest allowed Zod release.
- npm and pnpm resolve a tested-compatible graph.
- CI covers at least Zod `4.4.3` and the newest version permitted by metadata.
- No application-specific override is required.
- An incompatible Zod upgrade fails dependency validation or CI before local
  runtime startup.

## Workaround

Pin Zod exactly in the application and force the full pnpm graph to use it:

```yaml
overrides:
  zod: 4.4.3
```

Keep the direct dependency exact as well. Verify the runtime container's
resolved Zod version rather than relying only on the host lockfile.
