# Bug: TypeScript dev runner ignores the declared package manager

## Summary

**Status: confirmed defect.**

Atlas Explorer declares pnpm in `package.json` and checks in a pnpm lockfile
and workspace overrides. The generated TypeScript development supervisor
instead invokes npm installation and a full TypeScript build whenever it starts
or reloads the application.

Ten source-triggered reloads were observed during the migration. Each reload
entered the install/build path, even when dependency declarations had not
changed. This makes local Agentic runtime resolution differ from the
application's documented and tested pnpm graph.

## Environment

- Agentic CLI: `0.1.84-alpha` (`5c52c8f48`)
- Runner image: `runner-base-typescript-langgraph:0.1.84-alpha`
- Orchestration engine: `0.0.73`
- Declared package manager: `pnpm@11.25.0`
- Application lockfile: `pnpm-lock.yaml`
- Generated supervisor: `.agentic/dev-entrypoint.mjs`
- Node.js: 24

## Reproduction

1. Create a TypeScript agent whose `package.json` declares pnpm.
2. Add a pnpm lockfile and a pnpm override that materially affects runtime
   resolution.
3. Run `agentic dev up`.
4. Inspect the generated supervisor and process logs.
5. Change an ordinary `.ts` source file without changing `package.json`,
   `pnpm-lock.yaml`, or `pnpm-workspace.yaml`.
6. Repeat several times.
7. Inspect the runtime dependency tree and compare it with `pnpm install`.

## Actual behavior

The supervisor hardcodes npm installation and a full TypeScript build in its
process-start path. Ordinary source and environment changes trigger that path.

Consequences observed during the migration included:

- npm resolution did not consume pnpm workspace overrides;
- every reload incurred installation/resolution and build work;
- local runtime behavior could differ from host tests and builds;
- the incompatible Zod range was able to resolve differently in the runtime.

Ten `Source change detected; restarting services` events were counted, with ten
corresponding install/build cycles.

## Expected behavior

- The runner should detect and honor `packageManager`.
- pnpm projects should use the checked-in pnpm lockfile and overrides.
- Ordinary source changes should restart already-built runtime processes
  without reinstalling dependencies.
- Dependency installation should occur only when dependency inputs change.
- TypeScript rebuilds should be incremental where practical.

## Evidence

Evidence comes from the generated supervisor, application metadata, and local
development logs captured during the Atlas Explorer migration.

- `package.json` declares `pnpm@11.25.0`.
- The application contains `pnpm-lock.yaml` and `pnpm-workspace.yaml`.
- The generated supervisor invokes npm rather than pnpm.
- Its start/reload flow unconditionally enters SDK install and build work.
- Ten source reload events were observed in one development session.

The migration also contained a separate incident where Cursor ran a command
from the repository root despite a nested working-directory request. That
incident is not evidence against pnpm and is excluded from this report.

The exact duration varied by cache state. One inspected reload took roughly
eight seconds, but this report does not claim a fixed latency.

## Root cause

The TypeScript development runner has one npm-specific bootstrap path rather
than a package-manager abstraction. Restart logic calls that bootstrap path
without classifying the changed files, so source edits are treated like
dependency changes.

Generated runtime installation therefore has no obligation to reproduce the
dependency graph used by host-side pnpm commands.

## Impact

- Local development can test a different graph from CI or deployment.
- pnpm security policy, lockfile integrity, and overrides are bypassed.
- Reloads are slower and generate avoidable network/cache activity.
- Install-time scripts can run repeatedly.
- Dependency failures appear nondeterministic because host and runner disagree.

## Suggested fix

1. Parse the standard `packageManager` field.
2. Select pnpm, npm, yarn, or bun consistently with the project declaration.
3. Use frozen/immutable lockfile mode after initial setup.
4. Hash dependency inputs (`package.json`, lockfile, workspace config, patches)
   and reinstall only when that hash changes.
5. On source edits, run an incremental compile and restart only AER/Tool
   processes.
6. Print the selected package manager, lockfile, and dependency hash once.
7. Fail clearly when the declared manager is unavailable instead of silently
   falling back to npm.

## Acceptance criteria

- A pnpm project is installed with the declared pnpm version.
- The runtime graph honors `pnpm-lock.yaml` and workspace overrides.
- Saving a `.ts` file does not invoke any package installation command.
- Changing `package.json` or the lockfile performs exactly one reinstall.
- Reload logs distinguish dependency installation, compilation, and process
  restart.
- npm projects retain equivalent behavior.
- A regression test uses an override whose effect is visible at runtime.

## Workaround

Treat the generated runtime as npm-managed unless its dependency tree has been
verified. Pin critical compatibility dependencies directly in `package.json`
as well as pnpm overrides, then inspect the version inside the running
container.

For rapid source iteration, avoid unnecessary saves while a reload is in
progress. Do not edit the generated `.agentic` supervisor as a durable fix.
