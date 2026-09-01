# Integration bug: Prompt confirmation deadlocks runtime HITL

## Status

**Confirmed** during Atlas Explorer migration. The Atlas Explorer app prompt
has been fixed; template and integration guidance still need to prevent the
same configuration.

## Summary

Atlas Explorer initially combined two approval gates:

1. Its system prompt told the model to explain a mutation and wait for explicit
   chat approval.
2. LangChain `humanInTheLoopMiddleware` waited to intercept the emitted
   mutative tool call before execution.

The model obeyed the first gate and returned a textual approval request with
`tool_calls: []`. Because no tool call existed, runtime HITL had nothing to
intercept, so no review request could be created. The user could approve in
chat, but the intended runtime approval flow had not started.

## Environment

- Agentic CLI: `0.1.84-alpha`
- Playground UI: `0.1.84-alpha`
- Orchestration engine: `0.0.73`
- LangChain: `1.5.10`
- Deep Agents: `1.13.2`
- Local Docker development stack on macOS

## Reproduction

1. Configure `humanInTheLoopMiddleware` to interrupt a mutative tool.
2. Give the model a prompt or skill instruction that says to ask for
   confirmation and wait before calling that tool.
3. Ask the agent to perform the mutation.
4. Inspect the model response and execution graph.

## Actual behavior

- The model returns prose asking the user to approve.
- The successful model response contains `tool_calls: []`.
- No Tool Node or mutative MCP request runs.
- HITL middleware emits no interrupt because it only evaluates an emitted tool
  call.
- The runtime review UI has nothing to display.

This was not an MCP, Tool Pod, OE, or HITL transport failure. It was an
application prompt/runtime-policy integration deadlock.

## Expected behavior

For tools protected by runtime HITL, prompts and skills should instruct the
model to:

1. require an explicit user request for the mutation
2. emit the requested protected tool call without a second chat confirmation
3. allow middleware to suspend before execution
4. rely on the runtime review surface for Approve, Edit, Reject, or Respond

Chat confirmation remains appropriate only when the action is not protected by
runtime HITL or when separate domain-specific clarification is genuinely
required. Templates must distinguish clarification from duplicate approval.

## Evidence

- The affected execution's model node completed successfully.
- Its stored assistant response was textual approval-request content with
  `tool_calls: []` and no invalid tool calls.
- The execution graph contained no mutative Tool Node invocation for that
  request.
- The configured middleware only interrupts matching tool calls, so the empty
  tool-call array explains the absence of a runtime review.
- After the prompt was changed to say “emit the corresponding tool call
  immediately” and “Do not ask for separate confirmation in chat,” a live
  protected `mongodb__insert_many` smoke request reached HITL suspension. The
  smoke review was rejected and the tool did not execute.
- The current Atlas Explorer prompt and prompt regression tests encode the
  corrected policy.

## Root cause

The app treated model-level confirmation and runtime-level approval as
independent safety layers, but they are sequentially incompatible:

```text
model waits for chat approval
        ↓
no tool call is emitted
        ↓
HITL never receives an action to suspend
```

Runtime HITL is a pre-execution gate around an already-proposed tool call. It
cannot approve a hypothetical action expressed only in prose.

## Impact

- Protected operations appear unavailable even though tools and middleware are
  configured correctly.
- Users may repeatedly approve in chat without receiving a runtime review.
- Teams may incorrectly debug MCP registration, model capability, or OE.
- Inconsistent skills can reintroduce the deadlock even when the system prompt
  is correct.

## Implemented app fix

Atlas Explorer now tells the model that an explicitly requested protected
mutation should emit its tool call immediately and that runtime HITL will
suspend it before execution. Tests also reject the previous “wait for explicit
approval” wording.

This app fix does not remove the need for platform template and documentation
guidance because vendored skills, example prompts, and application overrides
can independently add the conflicting gate.

## Suggested template and documentation guidance

- Document that HITL middleware intercepts emitted tool calls, not textual
  intent.
- Provide canonical prompt language for protected tools.
- Warn against “ask, wait, then call” instructions for the same action already
  governed by runtime review.
- Require teams to audit system prompts, skills, and tool descriptions for
  duplicate confirmation rules.
- Include a minimal end-to-end HITL smoke test in templates.

## Regression acceptance

- Given an explicit request for a protected mutation, the model emits exactly
  one matching tool call without first asking for duplicate chat approval.
- The runtime suspends before the tool handler executes.
- The review payload contains the action name, arguments, allowed decisions,
  and interrupt ID.
- Reject completes without executing the tool.
- Approve executes the tool exactly once.
- Edit executes exactly once with the reviewed arguments.
- A request that lacks required parameters may ask for clarification without
  emitting a malformed mutation.
- Prompt and skill tests fail if duplicate “wait for confirmation” guidance is
  reintroduced for runtime-protected tools.

## Related report

[Review UI cannot resume agent-interrupt executions](./agent-interrupt-review-resume-409.md)
begins after a tool call has successfully reached suspension. This report
covers the earlier app integration failure in which no tool call or interrupt
was produced.
