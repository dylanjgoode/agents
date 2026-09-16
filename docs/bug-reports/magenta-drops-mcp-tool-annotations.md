# Bug: Magenta drops MCP tool annotations

## Summary

**Status: confirmed by source inspection in the pinned release and current**
`main`**.**

The Magenta TypeScript runtime drops standard MCP tool annotations while
discovering remote tools and again omits metadata when it creates secure
LangChain wrappers. Applications that call `app.getTools()` therefore cannot
inspect `readOnlyHint`, `destructiveHint`, or the other standard MCP hints.

This prevents applications such as Atlas Explorer from deriving read-only and
human-approval policy from the metadata published by a trusted MCP server.
They must instead maintain tool-name lists that can drift from the server
catalog.

## Environment

- Atlas Explorer Magenta dependencies:
  `8780ea124e6be996ef7b96885f14588195b98d96`
- Package: `@magenta/runner-shared-ts`
- Package: `@magenta/magenta-sdklanggraph-ts`
- LangChain: `1.5.10`
- Atlas Managed MCP over Streamable HTTP
- MCP protocol version documented by Atlas Managed MCP: `2025-11-25`

The same omission was present on the
`10gen/magenta-client-libraries` `main` branch when checked on
September 16, 2026.

## Reproduction

1. Configure a remote MCP server whose `tools/list` response includes standard
   annotations such as:
2. Let the Magenta AER discover the server during `App` initialization.
3. Call `app.getTools()` from a TypeScript LangGraph agent.
4. Inspect the corresponding LangChain tool's `metadata`.
5. Observe that `metadata.annotations` is absent.

The omission is also directly visible in the source path described below; a
live mutation or credential-bearing trace is not required to reproduce it.

## Actual behavior

`@magenta/runner-shared-ts` narrows each `tools/list` result to its name,
description, and input schema:

- `MCPToolBinding` has no annotations field.
- The internal `DiscoveredTool` interface has no annotations field.
- `listServerTools()` copies only `name`, `description`, and `inputSchema`.

`@magenta/magenta-sdklanggraph-ts` then loses the metadata at both LangChain
construction boundaries:

- `registerMcpTools()` creates the initial LangChain tool without `metadata`.
- In AER mode, `getTools()` recreates the tool around the secure execution
  wrapper without forwarding metadata from the original tool.

The standard LangChain JavaScript MCP adapter does preserve MCP annotations
under `tool.metadata.annotations`, but Magenta uses its own discovery and
wrapping implementation instead of that adapter.

## Expected behavior

Magenta should preserve the MCP `Tool.annotations` object from `tools/list`
through discovery, registration, secure wrapping, and `app.getTools()`.

For example, an application should be able to evaluate:

```ts
const annotations = tool.metadata?.annotations;
const isReadOnly =
  annotations?.readOnlyHint === true && annotations?.destructiveHint !== true;
```

Applications should still fail closed when annotations are absent, malformed,
or contradictory.

## Evidence

Pinned source:

- `MCPToolBinding` [omits annotations](https://github.com/10gen/magenta-client-libraries/blob/8780ea124e6be996ef7b96885f14588195b98d96/packages/runner-shared-ts/src/mcp_tools.ts#L42-L49)
- `DiscoveredTool` [omits annotations](https://github.com/10gen/magenta-client-libraries/blob/8780ea124e6be996ef7b96885f14588195b98d96/packages/runner-shared-ts/src/mcp_tools.ts#L157-L161)
- `tools/list` [discards annotations](https://github.com/10gen/magenta-client-libraries/blob/8780ea124e6be996ef7b96885f14588195b98d96/packages/runner-shared-ts/src/mcp_tools.ts#L383-L390)
- `registerMcpTools()` [constructs a tool without metadata](https://github.com/10gen/magenta-client-libraries/blob/8780ea124e6be996ef7b96885f14588195b98d96/packages/magenta-sdklanggraph-ts/src/runtime.ts#L320-L331)
- [AER wrapping reconstructs the tool without metadata](https://github.com/10gen/magenta-client-libraries/blob/8780ea124e6be996ef7b96885f14588195b98d96/packages/magenta-sdklanggraph-ts/src/runtime.ts#L1070-L1082)

Relevant contracts:

- [Atlas Managed MCP tool annotations](https://www.mongodb.com/docs/mcp-server/remote-mcp/security/#tool-annotations-and-destructive-operations)
- [MCP tool annotations](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

## Root cause

Magenta implements custom MCP discovery because it needs platform-specific
OAuth, egress handling, result normalization, and the AER/Tool Pod dispatch
split. That adapter models only the fields initially needed to bind and call a
tool. The later secure wrapper similarly forwards the tool schema and execution
metadata but not the original LangChain metadata.

The annotation data is lost inside the AER before application policy can
inspect it. This is not an Atlas MCP server defect and does not require an
Orchestration Engine API change.

## Impact

- Agents cannot programmatically distinguish read-only and mutative remote MCP
  tools using the server's standard hints.
- Human-in-the-loop policy must use hard-coded names or descriptions.
- New or renamed write tools can bypass a stale application-level HITL list.
- Read-only tool filtering cannot automatically track a trusted server's
  catalog.
- The behavior differs from LangChain's standard MCP adapter and can surprise
  application authors who expect `tool.metadata.annotations`.

Tool annotations are advisory and are not an authorization boundary. Even
after this defect is fixed, applications should trust annotations only from
configured servers they trust, fail closed on invalid hints, and retain
least-privilege Atlas roles or other server-side authorization.

## Suggested fix

1. Add a JSON-safe `annotations` field to the TypeScript `DiscoveredTool` and
   `MCPToolBinding` types.
2. Copy `tool.annotations` from every MCP `tools/list` result.
3. Attach the value as `metadata: { annotations: binding.annotations }` when
   `registerMcpTools()` creates the LangChain tool.
4. Preserve the original tool metadata when `getTools()` builds the AER secure
   wrapper.
5. Verify whether the Python runtime has the same omission and keep language
   behavior aligned.
6. Document that annotations are server-provided hints, not platform
   authorization or a substitute for HITL.

## Acceptance criteria

- A tool with `readOnlyHint: true` reaches `app.getTools()` with that exact
  Boolean under `tool.metadata.annotations`.
- `destructiveHint`, `idempotentHint`, and `openWorldHint` are preserved when
  supplied.
- Missing annotations remain missing rather than receiving permissive
  defaults.
- Metadata survives both local/raw tool registration and AER secure wrapping.
- MCP call-routing metadata remains internal and cannot be overwritten by
  server-provided annotations.
- Unit tests cover read-only, create, destructive, missing, and malformed
  annotation cases.
- Documentation warns consumers to fail closed and not treat annotations as  
  authorization.
