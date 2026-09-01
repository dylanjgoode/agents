# Bug: Review UI cannot resume agent-interrupt executions

## Summary

**Status: confirmed high-priority local playground/OE integration defect.**

The local playground correctly detects a LangGraph human-in-the-loop
interrupt and lists the execution under **Review Requests**, but submitting
an Approve, Edit, or Reject decision fails with HTTP 409.

The execution was suspended by LangChain's `humanInTheLoopMiddleware`, which
uses an `agent_interrupt` plus a `resume_map` keyed by interrupt ID. The
review page instead sends the decision through the orchestration engine's
generic `/resume/:execution_id` human-review path. The orchestration engine
rejects that path because agent interrupts must be answered through session
continuation.

## Environment

- Agentic CLI: `0.1.84-alpha` (`5c52c8f48`)
- Runner image: `runner-base-typescript-langgraph:0.1.84-alpha`
- Playground UI: `playground-ui:0.1.84-alpha`
- Orchestration engine: `0.0.73`
- LangChain: `1.5.10`
- Deep Agents: `1.13.2`
- Local Docker development stack on macOS

## Reproduction

1. Configure `humanInTheLoopMiddleware` to interrupt a tool such as
   `mongodb__insert_many`.
2. Start the local stack with `agentic dev up`.
3. Ask the agent to perform the protected mutation.
4. Confirm that the invocation suspends with:
   - `status: "suspended"`
   - `suspend_reason: "agent_interrupt"`
   - an interrupt ID, action request, review configuration, and
     `resume_schema` in the invocation response
5. Open **Review Requests** in the playground.
6. Open the suspended execution and submit an Approve, Edit, or Reject
   decision.

## Actual behavior

The review modal shows:

```text
Context Details
No review context provided.
```

Submitting the decision calls:

```text
POST /api/v1/executions/<execution-id>/resume
```

The UI receives HTTP 409 and displays:

```text
Failed to submit review. Please try again.
```

The underlying orchestration-engine response is:

```json
{
  "success": false,
  "execution_id": "<execution-id>",
  "status": "error",
  "error": "the suspension has pending agent interrupts; answer through the session continue path (a message, or a resume_map keyed by interrupt id)"
}
```

The persisted execution remains suspended:

```json
{
  "status": "suspended",
  "suspend_reason": "agent_interrupt",
  "suspend_context": null
}
```

The protected tool is never executed, so the failure is safe but leaves the
session blocked.

## Expected behavior

For an `agent_interrupt`, the playground should:

1. Show the pending action name, arguments, description, and allowed
   decisions from the interrupt context.
2. Submit the selected decision through session continuation using a
   `resume_map` keyed by the interrupt ID.
3. Resume the existing execution and reflect its completed or failed state.

Legacy human-review suspensions should continue using their existing generic
review endpoint.

## Evidence

For execution `d4c53845-ad25-4313-b5d9-6240c6940ee8`:

- The AER completed the model call and reported
  `AER: Execution d4c53845... -> SUSPENDED`.
- The orchestration-engine callback recorded `status: "SUSPENDED"` and
  `suspend_reason: "agent_interrupt"`.
- No MongoDB mutation tool ran before suspension.
- Two review submissions reached
  `/resume/d4c53845-ad25-4313-b5d9-6240c6940ee8`; both returned HTTP 409.

The behavior was reproduced with a separate diagnostic execution whose tool
arguments used an intentionally invalid connection ID. The same UI endpoint
returned the same 409 response quoted above.

## Root cause

The review UI and orchestration-engine resume contract do not distinguish
between two suspension types:

- Generic human review, handled by `/resume/:execution_id`
- LangGraph agent interrupts, handled through session continuation with an
  interrupt-keyed `resume_map`

Additionally, the execution record stores `suspend_context: null` even though
the initial invocation response contains the interrupt ID and resume schema.
After the review page fetches the execution, it therefore cannot reconstruct
the required agent-interrupt continuation payload.

## Suggested fix

1. Persist the full agent-interrupt context when the AER reports a suspended
   execution.
2. Return that context from the execution query API.
3. In the review UI, branch on `suspend_reason`:
   - `agent_interrupt`: render `actionRequests` and submit a session
     continuation `resume_map`
   - generic review: keep the existing review submission path
4. Surface the orchestration-engine error body in the UI instead of replacing
   it with a generic failure message.

## Acceptance criteria

- A protected tool call appears in Review Requests with its tool name and
  arguments.
- Approve resumes and executes the tool exactly once.
- Reject resumes without executing the tool.
- Edit resumes with the edited arguments.
- Reloading or directly opening Review Requests retains enough interrupt
  context to make a decision.
- Generic human-review suspensions continue to work.
- Invalid or stale interrupt IDs fail without executing the tool and display
  an actionable error.

## Workaround

The execution can be resumed programmatically through the session
continuation path using the interrupt ID and decision map returned by the
original suspended invocation. The current Review Requests modal cannot
perform that continuation.
