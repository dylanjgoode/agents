import { describe, expect, it } from "vitest";
import { DynamicStructuredTool } from "@langchain/core/tools";
import {
  formatToolErrorForAgent,
  recoverToolErrorsMiddleware,
  wrapToolErrorsAsResults,
} from "./tool-errors.js";

describe("formatToolErrorForAgent", () => {
  it("includes the tool name and error so the model can retry", () => {
    const text = formatToolErrorForAgent(
      "find",
      new Error(
        "Cannot do exclusion on field plot_embedding in inclusion projection",
      ),
    );
    expect(text).toContain('Tool "find" failed');
    expect(text).toContain("Do not stop the task");
    expect(text).toContain("plot_embedding");
  });
});

describe("wrapToolErrorsAsResults", () => {
  it("returns MCP query errors as tool output instead of throwing", async () => {
    const find = new DynamicStructuredTool({
      name: "find",
      description: "Run a MongoDB find",
      schema: { type: "object", properties: {} },
      func: async () => {
        throw new Error(
          "MCP tool 'find' on server 'mongodb' returned an error: Error running find: Cannot do exclusion on field plot_embedding in inclusion projection",
        );
      },
    });

    const wrapped = wrapToolErrorsAsResults(find);
    await expect(find.invoke({})).rejects.toThrow(/plot_embedding/);
    await expect(wrapped.invoke({})).resolves.toMatch(/plot_embedding/);
    await expect(wrapped.invoke({})).resolves.toMatch(/retry/i);
  });

  it("leaves objects without invoke unchanged", () => {
    const bare = { name: "find" };
    expect(wrapToolErrorsAsResults(bare as never)).toBe(bare);
  });
});

describe("recoverToolErrorsMiddleware", () => {
  it("converts thrown tool errors into ToolMessages", async () => {
    const hook = recoverToolErrorsMiddleware.wrapToolCall;
    expect(hook).toBeTypeOf("function");

    const result = await hook!(
      {
        toolCall: { id: "call-1", name: "find", args: {}, type: "tool_call" },
      } as never,
      async () => {
        throw new Error("Cannot do exclusion on field plot_embedding");
      },
    );

    expect(result).toMatchObject({
      tool_call_id: "call-1",
      name: "find",
    });
    expect(String((result as { content: string }).content)).toContain(
      "plot_embedding",
    );
  });
});
