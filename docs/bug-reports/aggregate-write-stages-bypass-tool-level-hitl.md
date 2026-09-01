# Design risk: Aggregate write stages bypass tool-level HITL

## Summary

**Status: design risk; exploit not reproduced.**

Atlas Explorer treats `mongodb__aggregate` as read-only and therefore does not
route it through human-in-the-loop (HITL) approval. MongoDB aggregation
pipelines can, however, persist results when their arguments contain `$out` or
`$merge`.

The current defense is a system-prompt instruction forbidding those stages.
The runtime policy classifies only the tool name, not its arguments, so it
cannot distinguish a read-only aggregate from a write-capable aggregate.

No write-through-aggregate exploit was performed during the migration. Atlas
Managed MCP may independently reject or constrain `$out` and `$merge`; that
server-side behavior still needs reproduction.

## Environment

- Agentic CLI: `0.1.84-alpha` (`5c52c8f48`)
- Runner image: `runner-base-typescript-langgraph:0.1.84-alpha`
- Playground UI: `playground-ui:0.1.84-alpha`
- Orchestration engine: `0.0.73`
- LangChain: `1.5.10`
- Deep Agents: `1.13.2`
- Atlas Managed MCP over streamable HTTP
- Local Docker development stack on macOS

## Reproduction

The policy gap can be reproduced without executing a write:

1. Start Atlas Explorer and inspect its discovered tools.
2. Confirm that `mongodb__aggregate` is exposed by `selectAtlasTools`.
3. Inspect `MUTATIVE_MCP_INTERRUPT_ON` and confirm that
   `mongodb__aggregate` is absent.
4. Compare two candidate calls:
   - a pipeline containing only read stages such as `$match`
   - a pipeline ending in `$out` or `$merge`
5. Observe that HITL receives only the common tool name and has no configured
   argument-aware rule that separates the two calls.

To determine whether this becomes an executable write, a controlled
reproduction must use a disposable collection and verify Managed MCP's
response. That destructive test was intentionally not run.

## Actual behavior

At the application policy layer, every `mongodb__aggregate` call is ungated
regardless of pipeline contents. The agent is instructed in its system prompt:

```text
Treat mongodb__aggregate as read-only. Never use $out or $merge in
mongodb__aggregate because those write stages cannot be approved independently
by the tool-level policy.
```

This is model guidance, not an enforcement boundary. If a model emitted such a
call, Atlas Explorer's name-based HITL configuration would not suspend it.
Whether Managed MCP would execute or reject it is not yet confirmed.

## Expected behavior

Write-capable aggregate pipelines should either:

- be rejected before execution, or
- suspend for approval with the pipeline arguments visible to the reviewer.

Ordinary read-only aggregates should remain available without unnecessary
approval.

## Evidence

- `agentPolicy.ts` uses an exact-name
  `MUTATIVE_MCP_INTERRUPT_ON` object; it contains database and Atlas mutation
  names but not `mongodb__aggregate`.
- `main.ts` passes that object directly to
  `humanInTheLoopMiddleware({ interruptOn: ... })`.
- `selectAtlasTools` excludes only Atlas-local tools and `shell_execute`;
  therefore `mongodb__aggregate` remains exposed.
- `systemMessage.ts` explicitly acknowledges that `$out` and `$merge` cannot
  be approved independently by the current tool-level policy.
- The README likewise describes aggregate as read-only by instruction rather
  than by argument validation.
- No `$out`/`$merge` tool invocation was attempted, and no Managed MCP
  acceptance or rejection was observed.

## Root cause

The safety policy uses tool identity as a proxy for mutability. That is
insufficient for tools whose effect depends on structured arguments.
`mongodb__aggregate` is mostly read-only, but the terminal `$out` and `$merge`
stages change its effect without changing its tool name.

The prompt prohibition compensates for the missing argument-aware policy but
does not provide deterministic enforcement.

## Impact

- A model mistake or prompt-injection-induced call could reach Managed MCP
  without application-level HITL.
- Reviewers receive no opportunity to inspect the target database, collection,
  or merge semantics before the call.
- Safety documentation can overstate coverage if it says every persistent
  mutation is protected.
- Actual database impact remains unconfirmed because Managed MCP may provide
  an independent guard.

## Suggested fix

Add argument-aware policy evaluation before tool execution:

1. Parse and validate the aggregate pipeline.
2. Detect `$out` or `$merge`, including their supported object forms.
3. Route write-capable pipelines to HITL or reject them.
4. Keep pipelines without write stages on the read-only path.
5. Treat malformed or unclassifiable pipelines as mutative and fail closed.

If the current HITL middleware cannot predicate on arguments, wrap
`mongodb__aggregate` with a policy-enforcing tool adapter or split read and
write aggregation into separately classified tools. Managed MCP enforcement,
if present, should remain defense in depth rather than the only application
control.

## Acceptance criteria

- A read-only aggregate executes without approval.
- An aggregate containing `$out` suspends or is rejected before MCP execution.
- An aggregate containing `$merge` suspends or is rejected before MCP
  execution.
- Alternate valid `$out` and `$merge` argument forms are covered.
- Malformed or unclassifiable pipelines fail closed.
- Tests prove that the protected call cannot execute before approval.
- A disposable-environment integration test records whether Managed MCP also
  rejects or permits both write stages.
- Documentation distinguishes application enforcement from Managed MCP
  behavior.

## Workaround

Keep the explicit system-prompt prohibition and avoid generating `$out` or
`$merge` through `mongodb__aggregate`. For higher-assurance deployments,
remove the aggregate tool or reject those stages in a wrapper until
argument-aware enforcement is available.
