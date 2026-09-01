# DX: Magenta TypeScript git packages are fragile to consume with pnpm

## Summary

**Status: confirmed packaging friction with separately identified environmental
noise.**

The Magenta TypeScript SDK was consumed as private git-subdirectory packages
rather than ordinary registry artifacts. The packages used wildcard internal
dependencies and recursive `prepare` scripts that ran npm installs and builds.
Installing that graph with pnpm required application-owned overrides, disabling
pnpm's exotic-subdependency protection, and eight build approvals for the same
four Magenta packages under authored and canonicalized git URLs.

The migration also encountered duplicate LangChain nominal types, TS2742
inferred-type portability failures, and `as never` casts at SDK boundaries.
These are observed symptoms of package-boundary/type-identity friction, not
proof that every symptom has one cause.

Some apparent pnpm workspace problems were instead caused by Cursor executing
commands from the repository root despite a requested nested working directory.
Those incidents must not be attributed to pnpm.

## Environment

- Agentic CLI: `0.1.84-alpha` (`5c52c8f48`)
- Runner image: `runner-base-typescript-langgraph:0.1.84-alpha`
- Orchestration engine: `0.0.73`
- Application package manager: pnpm
- Current application declaration: `pnpm@11.25.0`
- Required Node baseline observed from package engines: Node.js 24+
- Magenta source: private GitHub monorepo subdirectory packages

## Reproduction

1. Create a pnpm TypeScript application.
2. Add `@magenta/sdk-core-ts`, `@magenta/runner-shared-ts`,
   `@magenta/agentic-platform-memory-ts`, and
   `@magenta/magenta-sdklanggraph-ts` from git subdirectory URLs.
3. Install without workspace overrides or exotic dependency build approvals.
4. Observe unresolved or independently fetched wildcard internal Magenta
   dependencies and blocked package preparation.
5. Add overrides for every internal package to one commit.
6. Approve only the human-authored git selectors and reinstall.
7. Observe pnpm also evaluating canonicalized URL forms.
8. Add all authored and canonicalized selectors, set
   `blockExoticSubdeps: false`, and reinstall.
9. Build an application that passes LangChain objects across Magenta package
   boundaries and exports inferred graph values.

## Actual behavior

The application needed substantial package-manager policy to consume the SDK:

- four commit-pinned internal-package overrides;
- eight Magenta `allowBuilds` selectors: authored and canonicalized forms for
  each of four packages;
- `blockExoticSubdeps: false`;
- approval for `esbuild`;
- a Node upgrade after guidance initially suggested Node 20 while installed
  package engines required Node 24+.

The git packages' preparation recursively invoked npm installation/build work,
which increased install time and mixed package-manager policy inside a pnpm
consumer.

At TypeScript boundaries, the migration encountered duplicate LangChain
nominal type identities, TS2742 portability errors for inferred exports, and
`as never` casts used to bridge otherwise equivalent-looking types.

## Expected behavior

- Consumers should install one versioned, prebuilt SDK package from a registry.
- Internal dependencies should use explicit compatible versions.
- Installation should not recursively invoke another package manager.
- Build approvals should use stable package identities, not URL spellings.
- Public SDK declarations should expose portable named types without TS2742 or
  unsafe compatibility casts.
- The documented Node baseline should match package `engines`.

## Evidence

Evidence comes from the migration transcripts, installed package metadata,
TypeScript build failures, and the checked-in pnpm configuration.

Confirmed:

- the packages were installed from git subdirectories and marked private;
- internal dependency ranges included wildcards;
- package preparation invoked npm recursively;
- the final pnpm configuration contains four overrides, eight
  authored/canonicalized Magenta build selectors, `esbuild: true`, and
  `blockExoticSubdeps: false`;
- Node 22/npm 10 failed package engine checks, while Node 24+ succeeded;
- TS2742, duplicate nominal LangChain types, and `as never` bridges occurred
  during integration.

Not attributed to Magenta or pnpm:

- commands unexpectedly operating on the parent workspace;
- parent `node_modules` churn and a stalled parent install;
- lockfile confusion caused by those commands.

The transcript confirmed that Cursor's shell working-directory handling was
wrong in those cases; explicit `cd` fixed it.

The raw compiler output for every nominal-type failure is not retained, so this
report does not claim a single minimal compiler reproduction for all three
TypeScript symptoms.

## Root cause

The distributed artifact is still shaped like a monorepo development checkout:
private git packages, wildcard sibling references, and preparation scripts that
bootstrap and build recursively. A consumer package manager must reconstruct
monorepo resolution and authorize build scripts whose identities change during
git URL normalization.

Separately, public SDK types expose concrete LangChain types across package
boundaries. Multiple physical copies or version identities then become
nominally incompatible even when their structures appear equivalent.

## Impact

- Clean installs require undocumented, security-sensitive pnpm settings.
- Lockfiles and build approvals are verbose and easy to get wrong.
- Recursive installs are slow and broaden install-time code execution.
- Different package managers can produce different dependency identities.
- Consumers add unsafe casts or explicit annotations to satisfy TypeScript.
- Node baseline drift causes avoidable failed installs.

## Suggested fix

1. Publish prebuilt, versioned Magenta packages to an authenticated registry.
2. Replace wildcard internal dependencies with explicit semver ranges and use
   peer dependencies for shared LangChain type identities where appropriate.
3. Remove recursive `npm install` from `prepare`; build in release CI.
4. Publish complete JavaScript and declaration artifacts so consumer install
   scripts are unnecessary.
5. Export stable Magenta-owned interfaces at package boundaries instead of
   leaking package-instance-sensitive LangChain implementation types.
6. Add a supported pnpm fixture that installs with default security policy.
7. Align README requirements, `engines`, CI, and runner Node versions.
8. Until registry publication, provide a generated, commit-specific pnpm
   snippet and explain why each exception is required.

## Acceptance criteria

- A fresh pnpm project installs the SDK without `blockExoticSubdeps: false`.
- Consumers do not need duplicate URL-form build selectors.
- No package runs a recursive npm install during consumer installation.
- One lockfile resolves one copy of shared nominal type providers.
- A representative deep-agent application builds without TS2742 workarounds
  or `as never` casts at Magenta boundaries.
- The documented Node minimum matches every shipped package.
- npm and pnpm CI fixtures pass from clean caches.

## Workaround

Pin every Magenta git dependency to one commit, override all internal package
names to that same commit, and use the exact build selectors emitted by the
installed pnpm version. Review the implications before setting
`blockExoticSubdeps: false`.

Always verify the actual shell directory with `pwd` or use an explicit `cd`
before diagnosing nested-workspace behavior.
