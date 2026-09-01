# Bug: Suspended-session composer allows conflicting invocations

## Status

**Confirmed UI affordance/backend conflict:** the composer remained active
while the session awaited review, and a normal `/invoke/stream` request
returned HTTP 409.

Broader race semantics, including simultaneous review and message submission,
**need targeted reproduction**.

## Summary

After Atlas Explorer suspended on a LangChain agent interrupt, the playground
continued to present an active message composer. Sending a normal message
through that composer used the ordinary `/invoke/stream` path, but OE rejected
the request with HTTP 409 because the session already had a pending interrupt.

The UI offers an action that the backend contract does not permit. It should
either disable ordinary composition while review is pending or intentionally
route the message as a continuation of the suspended session.

## Environment

- Agentic CLI: `0.1.84-alpha`
- Playground UI: `0.1.84-alpha`
- Orchestration engine: `0.0.73`
- LangChain: `1.5.10`
- Deep Agents: `1.13.2`
- Local Docker development stack on macOS

## Reproduction

1. Ask Atlas Explorer to perform a protected mutation.
2. Wait for the execution to reach
   `status: "suspended"` and `suspend_reason: "agent_interrupt"`.
3. Leave the pending review unresolved.
4. Enter and submit another message in the still-active session composer.
5. Observe the normal `/invoke/stream` request.

## Actual behavior

- The composer appears available and accepts submission.
- The playground sends a normal invocation rather than an interrupt
  continuation.
- OE returns HTTP 409 because the session has a pending agent interrupt.
- The original execution remains suspended.

This is distinct from submitting a decision through the Review Requests modal:
both currently encounter a 409, but they originate from different UI actions
and request paths.

## Expected behavior

The product must choose and clearly expose one of these contracts:

### Option A: lock ordinary composition

- Disable the composer while an unresolved interrupt exists.
- Explain that the user must approve, edit, reject, or otherwise respond to
  the pending review.
- Provide a direct link or focus action for the pending review.

### Option B: route messages as continuation

- Treat a message entered during suspension as an intentional session
  continuation.
- Associate it with the pending interrupt and existing execution.
- Define how free-form text maps to supported HITL decisions or `resume_map`.
- Never silently create a second invocation for the same suspended state.

The UI must not imply that ordinary invocation is available when OE will
deterministically reject it.

## Evidence

- OE persisted the affected execution as suspended with a pending
  `agent_interrupt`.
- The playground composer remained enabled in that session.
- Composer submission called normal `/invoke/stream`.
- OE returned HTTP 409 rather than starting another execution.
- The protected tool remained unexecuted.

## Impact

- Users cannot tell which input surface is valid while a review is pending.
- Repeated submissions create noise and may encourage duplicate requests.
- If future backend behavior accepts overlapping invocations without explicit
  semantics, approval and message races could apply intent to the wrong state.
- Accessibility is degraded because enabled controls advertise an operation
  that cannot succeed.

## Race semantics needing reproduction

The following cases were not established by the observed 409 and need explicit
concurrency tests:

- message submission racing with Approve, Edit, or Reject
- two browser tabs acting on the same suspended session
- stale composer state after another client resolves the interrupt
- multiple pending interrupts in one session
- retry after a continuation response is accepted but its response is lost

OE should define optimistic concurrency or interrupt-version semantics for
these cases, and return stable conflict codes that let the UI refresh safely.

## Suggested fix

1. Include pending-interrupt state in the session API consumed by the
   playground.
2. Make the composer state derive from that authoritative session state.
3. Disable ordinary invoke submission by default while suspended.
4. If conversational continuation is supported, send it through the explicit
   continuation contract with interrupt identity/version.
5. Refresh session state on 409 and direct the user to the pending review.
6. Add multi-tab and concurrent review/message integration tests.

## Acceptance criteria

- A session with an unresolved interrupt cannot submit an accidental normal
  `/invoke/stream` request.
- The disabled state explains how to continue.
- If free-form continuation is supported, it resumes the existing suspended
  state and is documented and tested.
- Resolving review in another client updates or safely invalidates the local
  composer state.
- Review/message races produce one authoritative outcome and never execute a
  protected tool more than once.

## Related report

[Review UI cannot resume agent-interrupt executions](./agent-interrupt-review-resume-409.md)
documents the Review Requests modal's generic-resume 409. This report covers
the separate enabled-composer path and the missing suspended-session
affordance.
