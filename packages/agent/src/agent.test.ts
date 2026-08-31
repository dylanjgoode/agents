import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySaver } from "@langchain/langgraph";

const getMcpTools = vi.hoisted(() => vi.fn(async () => [] as { name: string }[]));
const createChatModel = vi.hoisted(() =>
  vi.fn(() => ({ provider: "mock-chat-model" })),
);
const todoListMiddleware = vi.hoisted(() =>
  vi.fn(() => ({ name: "todoListMiddleware" })),
);

vi.mock("./llm.js", () => ({
  createChatModel,
}));

vi.mock("./mcp/client.js", () => ({
  getMcpTools,
  getTools: getMcpTools,
}));

vi.mock("langchain", () => ({
  todoListMiddleware,
  createMiddleware: (config: { name: string }) => config,
}));

vi.mock("deepagents", () => {
  class StateBackend {}
  class FilesystemBackend {
    constructor(public readonly options: { rootDir: string; virtualMode: boolean }) {}
  }
  class CompositeBackend {
    constructor(
      public readonly state: unknown,
      public readonly routes: Record<string, unknown>,
    ) {}
  }
  return {
    StateBackend,
    FilesystemBackend,
    CompositeBackend,
    createDeepAgent: vi.fn(() => ({
      invoke: async () => ({}),
    })),
  };
});

import { createDeepAgent } from "deepagents";
import {
  createAgentGraph,
  createGraph,
  DESTRUCTIVE_MCP_INTERRUPT_ON,
  loadMcpTools,
  SKILLS_DIR,
} from "./agent.js";

describe("HITL interrupt map", () => {
  it("covers destructive MongoDB MCP tool names", () => {
    expect(DESTRUCTIVE_MCP_INTERRUPT_ON).toEqual({
      "drop-database": true,
      "drop-collection": true,
      "drop-index": true,
      "delete-many": true,
      "update-many": true,
    });
  });
});

describe("SKILLS_DIR", () => {
  it("resolves to the package skills directory", () => {
    expect(SKILLS_DIR).toMatch(/[/\\]packages[/\\]agent[/\\]skills$/);
  });
});

describe("createGraph", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMcpTools.mockResolvedValue([]);
    createChatModel.mockReturnValue({ provider: "mock-chat-model" });
    todoListMiddleware.mockReturnValue({ name: "todoListMiddleware" });
  });

  it("wires defaults: MemorySaver, disk skills backend, HITL map, loaded tools", async () => {
    const graph = await createGraph();

    expect(getMcpTools).toHaveBeenCalledOnce();
    expect(createChatModel).toHaveBeenCalledOnce();
    expect(createDeepAgent).toHaveBeenCalledOnce();

    const opts = vi.mocked(createDeepAgent).mock.calls[0]![0];
    expect(graph).toEqual({ invoke: expect.any(Function) });
    expect(opts.name).toBe("DeepAtlas");
    expect(opts.model).toEqual({ provider: "mock-chat-model" });
    expect(opts.tools).toEqual([]);
    expect(opts.skills).toEqual(["/skills/"]);
    expect(opts.interruptOn).toBe(DESTRUCTIVE_MCP_INTERRUPT_ON);
    expect(opts.checkpointer).toBeInstanceOf(MemorySaver);
    expect(opts.permissions).toEqual([
      { operations: ["write"], paths: ["/skills/**"], mode: "deny" },
    ]);
    expect(opts.middleware).toEqual([
      { name: "todoListMiddleware" },
      expect.objectContaining({ name: "recoverToolErrors" }),
    ]);
    expect(typeof opts.systemPrompt).toBe("string");
    expect(opts.systemPrompt).toContain("DeepAtlas");

    expect(opts.backend).toEqual(
      expect.objectContaining({
        routes: expect.objectContaining({
          "/skills/": expect.objectContaining({
            options: { rootDir: SKILLS_DIR, virtualMode: true },
          }),
        }),
      }),
    );
  });

  it("passes through checkpointer, backend, tools, and interruptOn", async () => {
    const checkpointer = { saver: "custom" };
    const backend = { kind: "custom-backend" };
    const tools = [{ name: "custom-tool" }];
    const interruptOn = { "custom-tool": true as const };

    await createGraph({
      checkpointer: checkpointer as never,
      backend: backend as never,
      tools: tools as never,
      interruptOn: interruptOn as never,
    });

    expect(getMcpTools).not.toHaveBeenCalled();
    const opts = vi.mocked(createDeepAgent).mock.calls[0]![0];
    expect(opts.checkpointer).toBe(checkpointer);
    expect(opts.backend).toBe(backend);
    expect(opts.tools).toBe(tools);
    expect(opts.interruptOn).toBe(interruptOn);
  });

  it("loads MCP tools when tools option is omitted", async () => {
    const mcpTools = [{ name: "find" }];
    getMcpTools.mockResolvedValue(mcpTools);

    await createGraph({});

    expect(getMcpTools).toHaveBeenCalledOnce();
    expect(vi.mocked(createDeepAgent).mock.calls[0]![0].tools).toBe(mcpTools);
  });

  it("is aliased as createAgentGraph", () => {
    expect(createAgentGraph).toBe(createGraph);
  });
});

describe("loadMcpTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMcpTools.mockResolvedValue([]);
  });

  it("returns tools from getMcpTools when the client module is present", async () => {
    const tools = [{ name: "aggregate" }];
    getMcpTools.mockResolvedValue(tools);

    await expect(loadMcpTools()).resolves.toEqual(tools);
    expect(getMcpTools).toHaveBeenCalledOnce();
  });

  it("propagates client loader failures", async () => {
    getMcpTools.mockRejectedValue(new Error("atlas down"));

    await expect(loadMcpTools()).rejects.toThrow("atlas down");
  });
});
