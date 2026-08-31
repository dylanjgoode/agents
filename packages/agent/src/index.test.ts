import { describe, expect, it, vi } from "vitest";

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

vi.mock("./mcp/client.js", () => ({
  getMcpTools: vi.fn(async () => []),
  getTools: vi.fn(async () => []),
  createAtlasMcpClient: vi.fn(),
  excludeLocalAtlasTools: vi.fn(),
  isLocalAtlasTool: vi.fn(),
}));

import * as agentPackage from "./index.js";
import { createGraph } from "./agent.js";
import { graph } from "./graph.js";

describe("package exports", () => {
  it("re-exports the graph factory and HITL map", () => {
    expect(agentPackage.createGraph).toBeTypeOf("function");
    expect(agentPackage.createAgentGraph).toBe(agentPackage.createGraph);
    expect(agentPackage.loadMcpTools).toBeTypeOf("function");
    expect(agentPackage.createChatModel).toBeTypeOf("function");
    expect(agentPackage.loadSystemPrompt).toBeTypeOf("function");
    expect(agentPackage.bootstrapAtlasMcp).toBeTypeOf("function");
    expect(agentPackage.getMcpTools).toBeTypeOf("function");
    expect(agentPackage.env).toBeTypeOf("object");
    expect(agentPackage.DESTRUCTIVE_MCP_INTERRUPT_ON["drop-database"]).toBe(true);
    expect(agentPackage.graph).toBe(agentPackage.createGraph);
  });

  it("exports graph as createGraph for LangGraph CLI", () => {
    expect(graph).toBe(createGraph);
  });
});
