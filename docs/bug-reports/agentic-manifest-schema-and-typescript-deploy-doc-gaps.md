# DX: Agent manifest schema and TypeScript deployment guidance are hard to discover

## Summary

**Status: confirmed documentation and schema-discoverability gap.**

While preparing Atlas Explorer for Magenta deployment, valid
`agent.yaml` network egress required trial validation and inspection of CLI
binary strings. A plausible top-level `egress` property was correctly rejected;
the accepted form placed the rules under `network.egress`.

The CLI provides validation but no discoverable schema command or IDE schema
location. TypeScript deployment guidance is also sparse, and local-development
help still refers to restarting “Python processes.”

`agentic build` requiring a workspace created by `agentic init` is expected
remote-build behavior, not a product defect. The documentation gap is that a
TypeScript developer must assemble the end-to-end runbook from multiple places.

## Environment

- Agentic CLI: `0.1.84-alpha` (`5c52c8f48`)
- Runner image: `runner-base-typescript-langgraph:0.1.84-alpha`
- Orchestration engine: `0.0.73`
- Agent language: TypeScript
- Manifest: `agent.yaml`

## Reproduction

1. Start from the TypeScript agent scaffold.
2. Add outbound destinations needed by both AER and Tool Pod.
3. Place an `egress` list at the manifest top level.
4. Run `agentic validate` and observe correct schema rejection.
5. Run top-level CLI help and validation help looking for schema inspection,
   schema export, or IDE integration.
6. Determine the accepted structure without an existing known-good example.
7. Run `agentic dev up --help`.
8. Run `agentic build` before `agentic init`.

## Actual behavior

- Top-level `egress` is invalid.
- The accepted structure is `network.egress`.
- Validation reports invalid fields but does not expose the complete schema or
  suggest an IDE schema source.
- The migration resorted to trial validation and binary-string inspection.
- `agentic dev up --help` describes hot reload in terms of Python processes
  even for a TypeScript project.
- `agentic build` reports that no workspace is registered and directs the user
  to `agentic init`; this part is expected and actionable.

## Expected behavior

- A versioned JSON Schema should be published and discoverable from CLI help.
- YAML editors should be able to associate `agent.yaml` with that schema.
- Validation errors should show the nearest valid parent path and allowed
  values.
- TypeScript docs should cover install, validate, init, secrets, build, deploy,
  and status in one runbook.
- Language-neutral help should say “agent processes,” or adapt to the manifest.

## Evidence

Evidence comes from the migration transcript, CLI help/version output,
validation attempts, and the final accepted `agent.yaml`.

Confirmed:

- a plausible top-level egress placement was rejected;
- `network.egress` validated;
- no schema-inspection command appeared in top-level CLI help;
- the session inspected binary strings to infer details;
- TypeScript `dev up` help said “Python processes”;
- `agentic build` without registration returned
  `no workspace registered: run 'agentic init'`.

The full original validation output and every rejected egress value were not
retained. This report therefore does not enumerate undocumented constraints
beyond those directly observed.

## Root cause

The CLI contains and enforces a manifest schema, but exposes it only through
pass/fail validation rather than as a first-class developer artifact. Existing
documentation and help text are weighted toward Python workflows, while the
TypeScript runner and deployment path are still alpha.

## Impact

- Developers discover valid configuration by trial and error.
- Egress mistakes delay local and cloud readiness.
- IDEs cannot provide completion or early validation.
- TypeScript users can misread Python-specific help as a runtime limitation.
- Expected workspace initialization can feel like a surprising build failure.

## Suggested fix

1. Add `agentic schema show`, `agentic schema path`, or equivalent output for
   the exact CLI version.
2. Publish a versioned JSON Schema and document YAML language-server mapping.
3. Enhance errors with valid parent paths, allowed enum values, and a minimal
   corrected snippet.
4. Add a TypeScript deployment guide:
   - select the required Node/package-manager version;
   - install, test, typecheck, and build locally;
   - run `agentic validate`;
   - authenticate and run `agentic init`;
   - configure manifest-declared secrets;
   - run `agentic build`, `agentic deploy`, and status checks.
5. Replace “Python processes” with language-neutral or manifest-aware text.
6. Explain directly that `build` is a remote workspace build, so initialization
   is a prerequisite.

## Acceptance criteria

- The schema for the installed CLI version is retrievable without binary
  inspection.
- An editor can validate and complete `agent.yaml`.
- An invalid top-level `egress` error points to `network.egress`.
- Allowed rule values are shown in validation output.
- TypeScript help never describes its processes as Python.
- One official runbook takes a fresh TypeScript app through init and deploy.
- The build prerequisite is documented as expected workflow.

## Workaround

Use a validated scaffold manifest as the source of truth, keep egress under
`network.egress`, and run `agentic validate` after every manifest change.

Initialize the remote workspace before building:

```text
agentic init
agentic build
agentic deploy
```

Treat the Python wording as a help-text defect, not a requirement to rewrite a
TypeScript agent.
