# Design risk: Automatic mutation retry can duplicate ambiguous writes

## Status

**Design risk confirmed in code; duplicate-write outcome needs targeted
reproduction.**

No duplicate mutation was observed during the migration. The current
middleware behavior is broad enough to make one possible when a mutative tool
fails with an unknown outcome.

## Summary

Atlas Explorer's `recoverToolErrorsMiddleware` catches every ordinary tool
error except a LangGraph interrupt, converts it into a model-readable
`ToolMessage`, and instructs the model:

```text
Do not stop the task. Read the error, correct the tool arguments, and retry.
```

The middleware does not classify tools as reads versus mutations, check
idempotency, or distinguish definitive pre-execution validation failures from
timeouts and other unknown-outcome errors.

Automatic correction is useful for read operations and rejected validation
requests. For an ambiguous write, however, the remote system may have committed
the mutation before the response was lost. A model retry can then perform the
write twice.

## Environment

- Agentic CLI: `0.1.84-alpha`
- Playground UI: `0.1.84-alpha`
- Orchestration engine: `0.0.73`
- LangChain: `1.5.10`
- Deep Agents: `1.13.2`
- Local Docker development stack on macOS

## Code path

Atlas Explorer registers `recoverToolErrorsMiddleware` after its HITL
middleware. `recoverToolCall`:

1. invokes the tool handler
2. rethrows LangGraph interrupts so runtime approval can suspend normally
3. catches every other error when a tool-call ID is present
4. returns a `ToolMessage` with `status: "error"`
5. tells the model to correct arguments and retry

Unit coverage confirms this behavior for a read-only projection error and
confirms that graph interrupts are rethrown. It does not cover mutative
unknown-outcome failures.

## Risk scenario requiring reproduction

1. A protected write is approved.
2. The MongoDB/Atlas service commits the write.
3. The response is lost, times out, or the connection closes before the client
   receives a definitive result.
4. The middleware converts the error into an instruction to retry.
5. The model emits an equivalent mutation.
6. Depending on HITL continuation semantics, the retry is reviewed again or
   otherwise re-enters the tool path.
7. The second call creates a duplicate document, repeats a non-idempotent
   update, or repeats an infrastructure action.

This sequence must be tested with a fault injected after commit but before the
successful response reaches the caller.

## Error classes that must be distinguished

### Definitive pre-execution failures

Examples include local schema validation, malformed arguments, unsupported
operators, authorization rejection before dispatch, or a server response that
explicitly guarantees no write occurred.

These can be safe candidates for argument correction, although mutations
should still return through the normal approval policy if their arguments
change.

### Unknown-outcome failures

Examples include request timeout, connection reset, proxy termination,
response deserialization failure after dispatch, or service unavailability
where commit status is unknown.

These must not trigger an automatic mutation retry. The system should inspect
the target state when possible and otherwise require operator review.

### Definitive post-execution failures

If the backend can prove the operation committed but response handling failed,
the agent should report the committed result or reconcile state. It must not
repeat the mutation.

## Expected behavior

- Read-only tools may use bounded automatic correction/retry for classified
  recoverable errors.
- Mutative tools must never auto-retry an unknown-outcome failure.
- Every tool and error should carry operation class, retryability, and outcome
  certainty.
- Retrying a corrected mutation should create a new explicit review showing
  changed arguments.
- Idempotent mutation support should use a stable platform-generated
  idempotency key retained across transport retries.
- When idempotency cannot be guaranteed, the UI should ask an operator to
  inspect current state and choose retry, reconcile, or stop.

## Evidence

- `recoverToolErrorsMiddleware` wraps all tool calls without consulting
  `MUTATIVE_MCP_INTERRUPT_ON` or another operation classification.
- Its only excluded error class is `GraphInterrupt`.
- Its error message always tells the model to retry.
- The request shape used by the wrapper includes tool name and call ID but no
  idempotency or outcome-certainty field.
- The existing unit test demonstrates automatic recovery using a read-only
  projection error; there is no test for timeout-after-commit behavior.
- Atlas Explorer's system prompt separately tells the model to correct and
  retry “invalid-query, projection, schema, or other recoverable” errors, but
  the middleware itself does not enforce that narrower set.

## Impact

- Duplicate inserts or repeated non-idempotent updates
- Repeated Atlas infrastructure or lifecycle operations
- A second approval that does not reveal the first write may already have
  committed
- Inconsistent state if a retry changes arguments instead of reconciling the
  original operation
- Misleading success after two effects were produced for one user intent

## Suggested fix

1. Default automatic model retry to read-only tools.
2. Introduce structured error classification:
   `phase`, `retryable`, `outcome`, and stable `code`.
3. Allow automatic mutation correction only for errors proven to occur before
   dispatch/execution.
4. Require a new HITL review when corrected mutation arguments differ.
5. Add platform idempotency keys for supported mutations and preserve the key
   across transport-level retries.
6. For unknown outcomes, perform a read-only reconciliation check when one is
   reliable; otherwise pause for operator review.
7. Bound all retries and record attempt lineage in execution telemetry.

## Acceptance criteria

- Read-only recoverable errors can still be corrected with a bounded retry.
- A definitive pre-execution mutation validation error can be corrected, but
  changed arguments require review.
- A timeout injected after a committed write never causes an automatic second
  mutation.
- Idempotency-enabled transport retries produce one effect.
- Unknown outcomes display operator guidance and correlation IDs.
- Tests cover inserts, non-idempotent updates, destructive operations, and
  infrastructure actions.
- Telemetry links the original call, review, error classification,
  reconciliation, and any authorized retry.

## Related reports

- [OpenAI Responses tool metadata grows sessions until HTTP 413](./openai-response-tool-metadata-body-growth-413.md)
  is a distinct, definitive pre-tool model-request failure; no mutation was
  dispatched, so it should not be treated as evidence of an ambiguous write.
- [Review UI cannot resume agent-interrupt executions](./agent-interrupt-review-resume-409.md)
  covers a pre-execution review failure where the protected tool did not run.
  This report concerns errors after an approved mutation may have been
  dispatched.
