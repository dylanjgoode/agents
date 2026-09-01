# DX: Playground suppresses actionable backend errors

## Status

**Confirmed** for review submission. The broader inventory of affected
playground requests **needs reproduction** across additional endpoints.

## Summary

The playground replaces useful backend failures with generic messages. During
Atlas Explorer HITL testing, the review UI displayed only:

```text
Failed to submit review. Please try again.
```

OE had returned explicit guidance explaining that the suspension contained
pending agent interrupts and had to be answered through session continuation
with a message or interrupt-keyed `resume_map`.

Other migration failures could only be diagnosed from container logs. The
playground should preserve a safe summary while providing sanitized,
expandable technical details and correlation identifiers.

## Environment

- Agentic CLI: `0.1.84-alpha`
- Playground UI: `0.1.84-alpha`
- Orchestration engine: `0.0.73`
- LangChain: `1.5.10`
- Deep Agents: `1.13.2`
- Local Docker development stack on macOS

## Reproduction

1. Create a LangChain `agent_interrupt` by requesting a protected mutation.
2. Open the execution under **Review Requests**.
3. Submit Approve, Edit, or Reject through the current review modal.
4. Compare the visible playground error with the OE HTTP response body.

## Actual behavior

The UI shows a generic retry instruction and discards the actionable OE
message. In the confirmed case, OE returned HTTP 409 with:

```text
the suspension has pending agent interrupts; answer through the session
continue path (a message, or a resume_map keyed by interrupt id)
```

The generic message gives no indication that retrying the same endpoint cannot
work. Similar app integration failures required Docker/container log access to
discover the responsible service and underlying error.

## Expected behavior

For a failed request, the playground should show:

- a concise, user-safe summary
- an expandable **Technical details** section containing the sanitized backend
  error code and message
- HTTP status and request/execution/session correlation identifiers
- the failing operation or endpoint category
- a copy-details action suitable for bug reports

Secrets, credentials, authorization headers, connection strings, private
arguments, and raw stack traces must not be exposed. The backend should return
structured, already-sanitized error fields rather than relying only on
frontend redaction.

Known errors should also drive specific UI behavior. A response that says an
agent interrupt requires session continuation should not be presented as a
transient failure that invites an identical retry.

## Evidence

- Two review submissions reached OE's generic resume endpoint and returned
  HTTP 409.
- OE's body contained the exact continuation guidance above.
- The UI rendered only **Failed to submit review. Please try again.**
- The execution remained safely suspended and the tool did not run.
- During the same migration, service logs were required to diagnose failures
  that were not represented with useful detail in the playground.

## Impact

- Developers cannot distinguish contract mismatches from transient failures.
- Generic retry guidance wastes time and can repeat unsafe or conflicting
  requests.
- Users without container access cannot self-diagnose local playground issues.
- Bug reports omit the error code and correlation data needed by platform
  owners.

## Suggested fix

1. Standardize an error envelope with `code`, safe `message`,
   `correlation_id`, `execution_id`, `retryable`, and optional safe `details`.
2. Render the safe message inline and sanitized details in an expandable panel.
3. Preserve HTTP status and correlation identifiers through playground proxy
   layers.
4. Map known non-retryable codes to corrective guidance and suppress blind
   retry affordances.
5. Log the full internal error server-side under the same correlation ID.
6. Add contract tests that verify sensitive fields are removed while useful
   backend guidance survives.

## Acceptance criteria

- The confirmed 409 displays the session-continuation guidance and execution
  ID without exposing secrets.
- The UI clearly labels whether retrying the same operation is appropriate.
- Expandable details work for invocation, streaming, review, and continuation
  failures.
- Unknown errors still provide status and correlation IDs.
- Redaction tests cover tokens, credentials, connection strings, tool
  arguments, and stack traces.
- The broader endpoint inventory is reproduced and documented before claiming
  complete playground coverage.

## Related reports

- [Review UI cannot resume agent-interrupt executions](./agent-interrupt-review-resume-409.md)
  contains the full resume-contract diagnosis and exact 409 evidence.
- [OpenAI Responses tool metadata grows sessions until HTTP 413](./openai-response-tool-metadata-body-growth-413.md)
  documents a distinct payload-growth failure. Its 413 detail should also be
  surfaced safely rather than reduced to a generic model invocation failure.
