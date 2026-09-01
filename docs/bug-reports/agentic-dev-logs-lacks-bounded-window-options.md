# DX: Agentic dev logs cannot select a bounded log window

## Summary

**Status: confirmed feature gap.**

`agentic dev logs` can select services but does not expose common log-window
controls such as `--tail`, `--since`, `--no-follow`, or timestamps. During the
Atlas Explorer migration, investigating recent startup and request failures
therefore required direct `docker logs` and `docker compose logs` commands.

This is a developer-experience feature request, not a runtime correctness bug.

## Environment

- Agentic CLI: `0.1.84-alpha` (`5c52c8f48`)
- Runner image: `runner-base-typescript-langgraph:0.1.84-alpha`
- Orchestration engine: `0.0.73`
- Local Docker development stack on macOS

## Reproduction

1. Run an Agentic local stack long enough to accumulate logs.
2. Run:

```text
agentic dev logs --help
```

3. Attempt to retrieve only the last 100 lines, the last five minutes, a
   non-following snapshot, or timestamped output.
4. Compare with Docker's log commands.

## Actual behavior

The command exposes service selection, including listing available services,
but no bounded-window or follow controls were found.

The migration repeatedly used direct Docker commands to:

- capture one service without following;
- limit investigation to recent startup/reload output;
- search for a specific execution or error;
- avoid replaying the complete accumulated log stream.

## Expected behavior

The Agentic wrapper should provide the routine filtering controls developers
need without requiring knowledge of generated Compose paths or container names.

At minimum:

- `--tail <n>`;
- `--since <duration-or-timestamp>`;
- `--follow` / `--no-follow`;
- `--timestamps`;
- one or more service selectors.

## Evidence

Evidence comes from `agentic dev logs --help` in CLI `0.1.84-alpha` and the
migration command history.

- Help exposed service discovery/selection.
- No tail, since, follow-mode, or timestamp option was available.
- The debugging session fell back to `docker compose ... logs --no-color` and
  `docker logs` multiple times.

This report does not claim the CLI loses logs or that following is broken. It
only describes the absence of bounded retrieval options.

## Root cause

The CLI log command is a thin service-oriented interface and does not forward
the common Docker/Compose log-window parameters. Generated container names and
Compose paths remain internal, but the supported wrapper does not replace the
missing controls.

## Impact

- Long-running stacks replay excessive output.
- Relevant failures are harder to isolate.
- Developers depend on implementation details under `.agentic`.
- Support instructions diverge between Agentic and Docker commands.
- Automated diagnostics cannot cheaply capture a small recent window.

## Suggested fix

1. Add `--tail`, `--since`, `--follow`, `--no-follow`, and `--timestamps`.
2. Preserve service selection and permit multiple services.
3. Default interactive use to a reasonable recent snapshot plus follow, or
   clearly document the existing default.
4. Add `--json` or structured output if underlying services support it.
5. Print the selected services and window before streaming.
6. Keep generated Compose/container details encapsulated.

## Acceptance criteria

- `agentic dev logs --tail 100 --no-follow` exits after at most 100 lines per
  documented semantics.
- `--since 5m` excludes older entries.
- `--timestamps` uses a documented timestamp format.
- Window flags work with one or several service selectors.
- Help includes examples for startup debugging and continuous following.
- Developers do not need to read `.agentic/docker-compose.dev.yml`.

## Workaround

Use the generated Compose project directly:

```text
docker compose -f .agentic/docker-compose.dev.yml logs --no-color <service>
```

Or use `docker logs` with the desired container and window flags. These
commands depend on generated implementation details and should remain a
temporary workaround.
