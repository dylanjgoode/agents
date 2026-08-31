import { ToolMessage } from "@langchain/core/messages";
import {
  DynamicStructuredTool,
  type StructuredToolInterface,
} from "@langchain/core/tools";
import { isGraphInterrupt } from "@langchain/langgraph";
import { createMiddleware } from "langchain";

/**
 * Turn a thrown tool/MCP error into text the model can read and retry from.
 */
export function formatToolErrorForAgent(toolName: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return (
    `Tool "${toolName}" failed. Do not stop the task. Read the error, ` +
    `correct the tool arguments, and retry.\n\n${detail}`
  );
}

/**
 * Wrap a LangChain tool so MCP/query failures return a string instead of throwing.
 * DeepAgents' filesystem `wrapToolCall` otherwise treats thrown errors as fatal
 * middleware failures (ToolNode will not convert them to ToolMessages).
 */
export function wrapToolErrorsAsResults(
  original: StructuredToolInterface,
): StructuredToolInterface {
  if (original instanceof DynamicStructuredTool) {
    const inner = original.func.bind(original);
    return new DynamicStructuredTool({
      name: original.name,
      description: original.description,
      schema: original.schema,
      metadata: original.metadata,
      responseFormat: original.responseFormat,
      returnDirect: original.returnDirect,
      func: async (input, runManager, config) => {
        try {
          return await inner(input, runManager, config);
        } catch (error) {
          return formatToolErrorForAgent(original.name, error);
        }
      },
    });
  }

  if (typeof original.invoke !== "function") {
    return original;
  }

  const invoke = original.invoke.bind(original);
  original.invoke = (async (input, config) => {
    try {
      return await invoke(input, config);
    } catch (error) {
      return formatToolErrorForAgent(original.name, error);
    }
  }) as typeof original.invoke;
  return original;
}

/**
 * Catch tool-call exceptions after other wrapToolCall hooks and return a
 * ToolMessage so the agent can self-correct (invalid MongoDB projections, etc.).
 */
export const recoverToolErrorsMiddleware = createMiddleware({
  name: "recoverToolErrors",
  wrapToolCall: async (request, handler) => {
    try {
      return await handler(request);
    } catch (error) {
      if (isGraphInterrupt(error)) {
        throw error;
      }
      const toolCall = request.toolCall;
      if (!toolCall?.id) {
        throw error;
      }
      return new ToolMessage({
        content: formatToolErrorForAgent(toolCall.name, error),
        tool_call_id: toolCall.id,
        name: toolCall.name,
        status: "error",
      });
    }
  },
});
