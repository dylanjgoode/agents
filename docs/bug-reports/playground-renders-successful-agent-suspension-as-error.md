# Bug: Playground renders successful agent suspension as an error

## Status

**Confirmed** in the local playground integration.

## Summary

When Atlas Explorer emitted a protected mutation, LangChain human-in-the-loop
middleware successfully interrupted the tool call and the Agent Execution
Runtime (AER) and orchestration engine (OE) recorded the execution as
`suspended`.

The playground nevertheless rendered a red **Something went wrong** error at
the same time as the amber **Awaiting human review** state. A suspension is an
expected, successful terminal state for the current invocation, not an
invocation failure.

## Environment

- Agentic CLI: `0.1.84-alpha`
- Playground UI: `0.1.84-alpha`
- Orchestration engine: `0.0.73`
- LangChain: `1.5.10`
- Deep Agents: `1.13.2`
- Local Docker development stack on macOS

## Reproduction

1. Configure LangChain `humanInTheLoopMiddleware` for a mutative tool.
2. Ask Atlas Explorer to perform a protected mutation.
3. Allow the model to emit the tool call.
4. Observe the invocation stream and playground status when the middleware
   interrupts before tool execution.

## Actual behavior

The same playground view simultaneously shows:

- a red **Something went wrong** failure message
- an amber **Awaiting human review** suspension message

The screenshot captured both states at once even though the backend had
successfully suspended the execution.

## Expected behavior

The client state reducer and UI should treat `suspended` as a distinct,
successful control-flow outcome:

1. An invocation event carrying `status: "suspended"` or an equivalent HITL
   interrupt must transition the invocation to `awaiting_review`.
2. That transition must clear any provisional transport or stream error that
   merely represents the stream ending without a normal completion.
3. The error banner must render only for a genuine terminal failure.
4. Review context and the continuation action should remain visible until the
   suspension is resolved.
5. A later resume should update the same logical invocation/session rather than
   creating a duplicate request.

The reducer should make terminal states mutually exclusive: `failed`,
`completed`, and `awaiting_review` must not render concurrently.

## Evidence

- The screenshot showed the red and amber states simultaneously.
- The AER logged the execution transition to `SUSPENDED`.
- OE persisted `status: "suspended"` with
  `suspend_reason: "agent_interrupt"`.
- The protected MongoDB tool did not execute before suspension.
- The original invocation response contained the interrupt identifier, action
  request, review configuration, and resume schema.

These backend observations confirm that the red state was a presentation/state
reduction error rather than an agent execution failure.

## Impact

Users are encouraged to retry a request that is already safely suspended.
Retrying can create another invocation or another pending action for the same
intent. For mutations, that creates duplicate-review and duplicate-write risk
if more than one invocation is later approved.

The contradictory states also undermine confidence in whether the requested
operation ran, failed, or is waiting for approval.

## Likely integration fault

The playground appears to infer failure from the invocation stream ending
without an ordinary completed response, then independently processes the
suspension event. The two updates are not reconciled into one authoritative
execution state.

The exact reducer branch still needs source-level confirmation in the
playground repository.

## Suggested fix

- Make the authoritative backend execution status win over generic stream
  termination handling.
- Represent suspension explicitly in the client state model.
- Clear stale invocation errors when a valid suspension payload arrives.
- Deduplicate retries by invocation/session identity and disable retry while a
  review is pending.
- Add reducer and component tests for out-of-order error and suspension events.

## Acceptance criteria

- A successful agent interrupt displays **Awaiting human review** without an
  error banner.
- The same invocation cannot be both failed and awaiting review.
- No retry affordance is shown while review is pending.
- Refreshing the page reconstructs the suspended state from OE.
- A genuine failure before suspension still renders an actionable error.
- Tests cover suspension arriving before and after a stream-close/error event.

## Related report

The separate review-submission contract failure is documented in
[Review UI cannot resume agent-interrupt executions](./agent-interrupt-review-resume-409.md).
That report covers the later 409 during resume; this report covers the
incorrect error shown when the initial invocation successfully suspends.
