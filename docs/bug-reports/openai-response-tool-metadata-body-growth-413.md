# Bug: OpenAI Responses tool metadata grows sessions until HTTP 413

## Summary

In the local Magenta Atlas Explorer, OpenAI Responses returned the complete
bound tool catalog in every `AIMessage.response_metadata.tools`. LangGraph
checkpointed each redundant copy, and later model calls resent those copies as
part of the assistant-message history.

With approximately 48 tools, each echoed catalog was about 95 KB. Execution
node inputs and outputs grew by about 102 KB per AI response until the
AER-to-Tool-Pod model request exceeded Fastify's default 1 MiB request-body
limit. After roughly 10 turns, the Tool Pod returned HTTP 413:

```text
LLM invocation error: LLM stream connection failed: tool pod returned 413: {"error":"Request body is too large"}
```

Sending the currently bound tools with each model invocation is legitimate and
required. The bug is retaining historical copies of that same catalog in
assistant-message response metadata, checkpointing them, and resending all of
those copies as chat history.

## Environment

- Agentic CLI: `0.1.84-alpha` (`5c52c8f48`)
- Runner image: `runner-base-typescript-langgraph:0.1.84-alpha`
- Playground UI: `playground-ui:0.1.84-alpha`
- Orchestration engine: `0.0.73`
- LangChain: `1.5.10`
- Deep Agents: `1.13.2`
- Model interface: OpenAI Responses API
- Local Docker development stack on macOS

## Reproduction

1. Start the local Agentic stack with Atlas Explorer configured to use the
   OpenAI Responses API and its full MongoDB/Atlas tool set.
2. Create a durable playground session so LangGraph checkpoints the message
   state between turns.
3. Send a sequence of prompts that each produce an AI response. Read-only
   requests are sufficient; tool execution is not required to trigger the
   growth.
4. Inspect each checkpointed `AIMessage` and confirm that
   `response_metadata.tools` contains the complete bound tool definitions.
5. Observe the execution node's serialized input and output size after each
   turn.
6. Continue the same session for approximately 10 turns.
7. Ask for a protected mutation that would normally produce a tool call and
   suspend at the human-in-the-loop review boundary.

## Actual behavior

Every AI turn adds another historical copy of the tool catalog. The next model
request contains the current bound tool definitions, as expected, plus the
redundant tool arrays retained on prior assistant messages.

The serialized AER-to-Tool-Pod request eventually exceeds 1 MiB. Fastify
rejects it before the model can produce the requested mutative tool call:

```text
LLM invocation error: LLM stream connection failed: tool pod returned 413: {"error":"Request body is too large"}
```

The mutative request therefore never reaches the human-in-the-loop interrupt.
No protected mutation executes, but the existing session can no longer make
normal progress.

## Expected behavior

- Each current model invocation may send the complete currently bound tool
  catalog once through the model's tool-binding field.
- Historical assistant messages must not retain or resend duplicate tool
  definitions in `response_metadata`.
- Checkpoint and model-request growth should reflect conversation content, not
  one extra tool catalog per AI response.
- A protected mutation should reach the human-in-the-loop interrupt regardless
  of the number of preceding ordinary turns.

## Evidence

- The agent exposed approximately 48 tools.
- OpenAI Responses echoed approximately 95 KB of tool definitions in
  `AIMessage.response_metadata.tools` on each AI turn.
- Serialized execution node inputs and outputs grew by approximately 102 KB
  per response.
- The accumulated request crossed Fastify's default 1 MiB body limit after
  roughly 10 turns.
- The resulting failure was HTTP 413 with
  `{"error":"Request body is too large"}`.
- A mutative request made after the session had bloated failed during model
  invocation, before it could emit a tool call or create a HITL review
  request.

The measurements are approximate because serialization overhead varies with
message content, but the per-turn increase tracked one additional serialized
tool catalog.

## Root cause and data flow

1. Atlas Explorer binds the current MongoDB and Atlas tools to the model.
2. The AER sends those tool definitions for the current OpenAI Responses
   invocation. This copy is valid and must remain.
3. The OpenAI Responses integration constructs an `AIMessage` whose
   `response_metadata.tools` also contains the complete bound catalog.
4. LangGraph checkpoints that `AIMessage`, including the echoed tools.
5. On the next turn, LangGraph restores the prior messages and the model
   request serializes them as chat history.
6. Each prior assistant message contributes another redundant catalog, while
   the current request also carries the legitimate current tool binding.
7. The request grows approximately linearly by one catalog per AI turn until
   the Tool Pod's Fastify parser rejects it at 1 MiB.

The immediate limit is enforced by Fastify, but merely increasing that limit
would postpone the failure while preserving unbounded checkpoint, transport,
and model-request growth.

## Impact

- Durable sessions fail after a modest number of turns even when user messages
  and model responses are small.
- Checkpoint storage and execution payloads grow unnecessarily.
- AER-to-Tool-Pod transport incurs repeated serialization and transfer of the
  same schemas.
- Requests can fail before tool generation and before HITL policy evaluation.
- Users must abandon or repair affected sessions to continue.

## Implemented mitigation

Atlas Explorer now registers a `wrapModelCall` middleware around model
invocations.

Before invoking the model handler, it removes
`response_metadata.tools` from every prior message in `request.messages`. This
prevents historical tool echoes restored from existing checkpoints from being
resent in the next model request.

After the handler returns, it removes `response_metadata.tools` from the new
AI response before LangGraph checkpoints it. Other response metadata, such as
model and token-usage information, is preserved.

This mitigation intentionally does not remove the model's current bound tools.
It removes only redundant copies embedded in assistant-message metadata.

## Suggested platform or upstream fix

The OpenAI Responses-to-`AIMessage` conversion should omit the bound tool
catalog from `response_metadata`, or mark it as non-persistable and
non-forwardable diagnostic data. LangGraph/model request serialization should
also avoid forwarding provider response metadata that is not part of the
assistant's conversational content.

As defense in depth, the platform could:

1. Filter `response_metadata.tools` before checkpoint persistence.
2. Filter non-conversational response metadata when serializing historical
   messages for model providers.
3. Add payload-size diagnostics that identify the fields responsible for
   request growth before the Tool Pod returns a generic 413.

Raising the Tool Pod body limit may provide temporary headroom, but it is not a
complete fix.

## Acceptance criteria

- The currently bound tool catalog is still sent once for each model
  invocation.
- New checkpointed AI messages do not contain
  `response_metadata.tools`.
- Historical messages containing `response_metadata.tools` are sanitized
  before the model handler receives or serializes them.
- Useful response metadata remains intact.
- Execution input/output sizes do not increase by approximately one tool
  catalog per AI turn.
- A session can run well beyond 10 turns without encountering the described
  HTTP 413 under otherwise equivalent conditions.
- A protected mutation after a long conversation reaches the HITL interrupt
  and does not execute before approval.
- Regression tests cover both historical-message cleanup and new-response
  cleanup.

## Workaround and recovery

For new sessions, enable the `wrapModelCall` cleanup middleware before
continuing normal use.

For an existing bloated session that can still reach model middleware, make
one invocation with the cleanup enabled. It strips the historical tool arrays
before the outbound model request, and subsequent checkpoints no longer add
new copies.

If the session cannot reach middleware because an earlier request boundary
rejects the already-bloated state, start a new session or repair the stored
checkpoint out of band by deleting only `response_metadata.tools` from
assistant messages. Preserve message content, tool calls, tool results,
interrupt state, and all unrelated metadata. Back up the checkpoint before
manual repair.

Temporarily increasing Fastify's request-body limit can allow one recovery
invocation to pass through the cleanup middleware, but should be reverted after
the checkpoint is compacted because it does not prevent future growth by
itself.
