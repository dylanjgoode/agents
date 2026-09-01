# Bug: Agentic --no-log still attempts to open a log file

## Summary

**Status: confirmed low-to-medium severity CLI defect.**

Agentic's global `--no-log` option does not prevent early logfile
initialization. In a sandboxed or read-only home directory, commands emit a
permission warning while trying to open a log even when logging is explicitly
disabled.

The behavior was reproduced with validation and help/version-style commands.
The requested command can still succeed, but automation receives avoidable
stderr noise and the flag does not fulfill its stated purpose.

## Environment

- Agentic CLI: `0.1.84-alpha` (`5c52c8f48`)
- Runner image: `runner-base-typescript-langgraph:0.1.84-alpha`
- Orchestration engine: `0.0.73`
- Read-only or sandbox-restricted home/log directory
- macOS

## Reproduction

1. Run the CLI with a home or logging directory where logfile creation is not
   permitted.
2. Put the global flag before the subcommand:

```text
agentic --no-log validate
```

3. Put the flag after the subcommand:

```text
agentic validate --no-log
```

4. Repeat with a help or version command that should not require persistent
   logging.

## Actual behavior

Both flag placements still attempt to open a CLI logfile and emit a permission
warning. Validation itself succeeds afterward.

Help/version-style invocations also initialize logging early enough to produce
the same class of warning in the restricted environment.

## Expected behavior

- `--no-log` should prevent logfile path resolution, creation, and opening.
- Read-only commands should not require a writable home directory.
- Help and version output should be side-effect free.
- A disabled logger should not emit permission warnings about its own file.

## Evidence

Evidence comes from direct CLI probes during the independent local-DX audit:

- `agentic --no-log validate`;
- `agentic validate --no-log`;
- a version invocation used to record CLI `0.1.84-alpha`.

Both validation flag positions emitted the warning before succeeding. The
transcript retained the behavior but not one canonical absolute logfile path,
so this report does not assert that the path is identical on every platform.

## Root cause

File logging is initialized before global/subcommand option handling disables
it. Parsing may accept `--no-log`, but by then the logger has already resolved
or opened its destination.

Help and version commands appear to pass through the same eager logger setup.

## Impact

- CI and sandbox logs contain misleading permission warnings.
- Strict wrappers may treat stderr as command failure.
- Read-only validation appears to require filesystem access.
- Users cannot reliably suppress persistent CLI logging.
- Help and version commands have unnecessary side effects.

## Suggested fix

1. Parse global flags before initializing logging.
2. Represent disabled logging with a no-op logger that never resolves a file
   path.
3. Skip file logging entirely for help and version commands.
4. Add tests with an unwritable home/log directory.
5. Keep console diagnostics independent from persistent logfile setup.
6. If logging cannot be disabled for a command, reject the flag explicitly
   rather than silently attempting the file.

## Acceptance criteria

- `agentic --no-log validate` opens no logfile.
- The documented alternate flag placement behaves consistently or is rejected
  with clear usage.
- Help and version commands make no filesystem writes.
- All three commands succeed without logging warnings under a read-only home.
- Tests assert that no logfile path is created or opened.
- Normal logging behavior remains unchanged without `--no-log`.

## Workaround

Provide a writable CLI log directory or tolerate/filter the warning. This does
not make `--no-log` function correctly, but it prevents permission noise from
masking the command's real result.
