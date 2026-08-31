import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./llm.js", () => ({
  createChatModel: vi.fn(() => ({})),
}));

vi.mock("langchain", () => ({
  todoListMiddleware: () => ({ name: "todoListMiddleware" }),
  createMiddleware: (config: { name: string }) => config,
}));

vi.mock("deepagents", () => ({
  createDeepAgent: vi.fn(() => ({ invoke: async () => ({}) })),
  CompositeBackend: class CompositeBackend {},
  FilesystemBackend: class FilesystemBackend {},
  StateBackend: class StateBackend {},
}));

function moduleNotFound(message: string, code?: string) {
  const err = new Error(message) as NodeJS.ErrnoException;
  if (code) {
    err.code = code;
  }
  throw err;
}

describe("loadMcpTools client module edges", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("./mcp/client.js");
    vi.restoreAllMocks();
  });

  it("returns [] and warns when the MCP client module is missing", async () => {
    vi.resetModules();
    vi.doMock("./mcp/client.js", () =>
      moduleNotFound("Cannot find module './mcp/client.js'", "ERR_MODULE_NOT_FOUND"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { loadMcpTools, DESTRUCTIVE_MCP_INTERRUPT_ON } =
      await import("./agent.js");
    await expect(loadMcpTools()).resolves.toEqual([]);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("MCP client is not wired yet"),
    );
    expect(warn.mock.calls[0]?.[0]).toContain(
      Object.keys(DESTRUCTIVE_MCP_INTERRUPT_ON).join(", "),
    );
  });

  it("returns [] when the missing module error only matches the message", async () => {
    vi.resetModules();
    vi.doMock("./mcp/client.js", () =>
      moduleNotFound("Cannot find module '/abs/mcp/client.js'"),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { loadMcpTools } = await import("./agent.js");
    await expect(loadMcpTools()).resolves.toEqual([]);
  });

  it("rethrows non-missing-module import failures", async () => {
    vi.resetModules();
    vi.doMock("./mcp/client.js", () => {
      throw new Error("syntax error in client");
    });

    const { loadMcpTools } = await import("./agent.js");
    await expect(loadMcpTools()).rejects.toSatisfy((err: unknown) => {
      const messages: string[] = [];
      for (
        let current: unknown = err;
        current != null;
        current = (current as { cause?: unknown }).cause
      ) {
        if (current instanceof Error) messages.push(current.message);
      }
      return (
        messages.some((message) => /syntax error in client/.test(message)) &&
        !messages.some((message) => /Cannot find module/.test(message))
      );
    });
  });

  it("falls back to getTools when getMcpTools is not exported", async () => {
    vi.resetModules();
    const getTools = vi.fn(async () => [{ name: "from-getTools" }]);
    vi.doMock("./mcp/client.js", () => ({
      getMcpTools: undefined,
      getTools,
    }));

    const { loadMcpTools } = await import("./agent.js");
    await expect(loadMcpTools()).resolves.toEqual([{ name: "from-getTools" }]);
    expect(getTools).toHaveBeenCalledOnce();
  });

  it("throws when the client module exports neither loader", async () => {
    vi.resetModules();
    vi.doMock("./mcp/client.js", () => ({
      getMcpTools: undefined,
      getTools: undefined,
    }));

    const { loadMcpTools } = await import("./agent.js");
    await expect(loadMcpTools()).rejects.toThrow(
      /does not export getMcpTools\(\) \(or getTools\(\)\)/,
    );
  });
});
