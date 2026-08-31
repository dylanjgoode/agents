import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CompositeBackend,
  createDeepAgent,
  FilesystemBackend,
  StateBackend,
  type CreateDeepAgentParams,
  type DeepAgent,
} from "deepagents";
import { MemorySaver } from "@langchain/langgraph";
import { todoListMiddleware } from "langchain";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createChatModel } from "./llm.js";
import { recoverToolErrorsMiddleware } from "./mcp/tool-errors.js";
import { SYSTEM_PROMPT } from "./prompt.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Vendored MongoDB Agent Skills (`SKILL.md` trees). */
export const SKILLS_DIR = path.resolve(__dirname, "../skills");

/**
 * HITL interrupts for destructive Atlas Managed MCP tools.
 *
 * Names match the MongoDB MCP Server. Until `./mcp/client.ts` is wired these
 * keys are inert (no matching tools are registered). Keep this map in sync
 * when MCP lands — do not implement MCP auth here.
 *
 * @see https://www.mongodb.com/docs/mcp-server/tools/
 */
export const DESTRUCTIVE_MCP_INTERRUPT_ON: Record<string, true> = {
  "drop-database": true,
  "drop-collection": true,
  "drop-index": true,
  "delete-many": true,
  "update-many": true,
};

type McpClientModule = {
  getMcpTools?: () => Promise<StructuredToolInterface[]>;
  getTools?: () => Promise<StructuredToolInterface[]>;
};

function isModuleNotFound(err: unknown): boolean {
  let current: unknown = err;
  for (let i = 0; i < 4 && current != null; i += 1) {
    if (typeof current !== "object") return false;
    const code = (current as { code?: string }).code;
    if (
      code === "ERR_MODULE_NOT_FOUND" ||
      code === "MODULE_NOT_FOUND" ||
      (current instanceof Error && /Cannot find module/.test(current.message))
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Load Atlas MCP tools from `./mcp/client.js` when that module exists.
 * Another agent owns MCP auth; this only consumes `getMcpTools` (or `getTools`).
 *
 * If MCP is not wired yet, returns `[]` so the graph can still be constructed
 * for local prompt/harness work. If the client module exists but fails, throws.
 */
export async function loadMcpTools(): Promise<StructuredToolInterface[]> {
  // Dynamic specifier so tsc does not require mcp/client.ts to exist yet.
  const specifier = new URL("./mcp/client.js", import.meta.url).href;

  let mod: McpClientModule;
  try {
    mod = (await import(specifier)) as McpClientModule;
  } catch (err) {
    if (isModuleNotFound(err)) {
      console.warn(
        "[agent] MCP client is not wired yet (packages/agent/src/mcp/client.ts). " +
          "Starting with tools: []. HITL interruptOn is pre-configured for " +
          `${Object.keys(DESTRUCTIVE_MCP_INTERRUPT_ON).join(", ")}.`,
      );
      return [];
    }
    throw err;
  }

  const loader = mod.getMcpTools ?? mod.getTools;
  if (typeof loader !== "function") {
    throw new Error(
      "Atlas MCP client is present but does not export getMcpTools() (or getTools()).",
    );
  }

  return loader();
}

function createSkillsBackend() {
  return new CompositeBackend(new StateBackend(), {
    "/skills/": new FilesystemBackend({
      rootDir: SKILLS_DIR,
      virtualMode: true,
    }),
  });
}

/** Optional overrides for {@link createGraph}. Omitted fields keep current defaults. */
export type CreateGraphOptions = {
  /** Persistence for graph state. Defaults to `MemorySaver` (required when interruptOn is set). */
  checkpointer?: CreateDeepAgentParams["checkpointer"];
  /** Skills / filesystem backend. Defaults to disk skills + StateBackend. */
  backend?: CreateDeepAgentParams["backend"];
  /** Tool list. Defaults to `loadMcpTools()`. */
  tools?: StructuredToolInterface[];
  /** HITL interrupts by tool name. Defaults to {@link DESTRUCTIVE_MCP_INTERRUPT_ON}. */
  interruptOn?: CreateDeepAgentParams["interruptOn"];
};

/**
 * Assemble the Deep Agents harness and return the compiled LangGraph graph.
 *
 * Harness: skills progressive disclosure, virtual filesystem, general-purpose
 * subagents, planning (`write_todos`), and HITL on destructive MCP tools.
 */
export async function createGraph(
  options: CreateGraphOptions = {},
): Promise<DeepAgent> {
  const tools = options.tools ?? (await loadMcpTools());
  const model = createChatModel();

  return createDeepAgent({
    name: "DeepAtlas",
    model,
    tools,
    systemPrompt: SYSTEM_PROMPT,
    skills: ["/skills/"],
    backend: options.backend ?? createSkillsBackend(),
    permissions: [
      { operations: ["write"], paths: ["/skills/**"], mode: "deny" },
    ],
    middleware: [todoListMiddleware(), recoverToolErrorsMiddleware],
    interruptOn: options.interruptOn ?? DESTRUCTIVE_MCP_INTERRUPT_ON,
    checkpointer: options.checkpointer ?? new MemorySaver(),
  });
}

/** Alias for callers that prefer an explicit factory name. */
export const createAgentGraph = createGraph;

export type AgentGraph = DeepAgent;
