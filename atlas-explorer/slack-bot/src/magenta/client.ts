import { z } from "zod";

import type {
  AgenticClientConfig,
  InvocationResult,
  InvokeInput,
  ResumeInput,
} from "./types.js";

const actionRequestSchema = z.object({
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  description: z.string().optional(),
});

const interruptSchema = z.object({
  id: z.string().min(1),
  value: z.object({
    actionRequests: z.array(actionRequestSchema).min(1),
    reviewConfigs: z.array(z.unknown()).optional(),
  }),
});

const invokeResponseSchema = z.object({
  success: z.boolean().optional(),
  response: z.string().optional(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
  session_id: z.string().optional(),
  execution_id: z.string().optional(),
  status: z.string().optional(),
  suspend_context: z
    .object({
      interrupts: z.array(interruptSchema).optional(),
      resume_schema: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough()
    .optional(),
});

interface ClientOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export class AgenticApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "AgenticApiError";
    this.status = status;
    this.code = code;
  }
}

export class MagentaClient {
  private readonly config: AgenticClientConfig;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: AgenticClientConfig, options: ClientOptions = {}) {
    this.config = {
      ...config,
      baseUrl: config.baseUrl.replace(/\/+$/, ""),
    };
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 280_000;
  }

  invoke(input: InvokeInput): Promise<InvocationResult> {
    const message = input.message.trim();
    if (!message) {
      return Promise.reject(
        new AgenticApiError("Agent message cannot be empty", 0, "INVALID_INPUT"),
      );
    }

    // The cloud gateway blocks by default and treats `wait` as agent payload.
    // The local Playground proxy forwards to OE, where `wait: true` requests
    // the terminal result instead of an accepted/running response.
    return this.post({
      message,
      ...(this.config.invokeTarget === "local" ? { wait: true } : {}),
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      user_id: input.slackUserId,
    });
  }

  resume(input: ResumeInput): Promise<InvocationResult> {
    const decisions = Array.isArray(input.decision)
      ? input.decision
      : [input.decision];
    const resumeMap = Object.fromEntries(
      [
        { interruptId: input.interruptId, decisions },
        ...(input.additionalInterrupts ?? []).map((interrupt) => ({
          interruptId: interrupt.interruptId,
          decisions: Array.isArray(interrupt.decision)
            ? interrupt.decision
            : [interrupt.decision],
        })),
      ].map(({ interruptId, decisions: interruptDecisions }) => [
        interruptId,
        { decisions: interruptDecisions },
      ]),
    );
    return this.post({
      session_id: input.sessionId,
      user_id: input.slackUserId,
      ...(this.config.invokeTarget === "local" ? { wait: true } : {}),
      resume_map: resumeMap,
    });
  }

  private async post(body: Record<string, unknown>): Promise<InvocationResult> {
    const sessionId =
      typeof body.session_id === "string" ? body.session_id : undefined;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }
    if (sessionId) {
      headers["X-Session-ID"] = sessionId;
    }

    let response: Response;
    try {
      response = await this.fetchFn(this.invokeUrl(), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Agentic request failed";
      throw new AgenticApiError(message, 0, "REQUEST_FAILED");
    }

    const rawBody = await response.text();
    let raw: unknown;
    try {
      raw = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      throw new AgenticApiError(
        `Agentic API returned non-JSON content (HTTP ${response.status})`,
        response.status,
        "INVALID_RESPONSE",
      );
    }

    const parsed = invokeResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AgenticApiError(
        "Agentic API returned an invalid response",
        response.status,
        "INVALID_RESPONSE",
      );
    }

    const data = parsed.data;
    if (!response.ok || data.success === false) {
      throw new AgenticApiError(
        data.error ?? `Agentic API request failed (HTTP ${response.status})`,
        response.status,
        data.code,
      );
    }

    const returnedSessionId =
      data.session_id ?? response.headers.get("X-Session-ID") ?? undefined;
    if (!returnedSessionId) {
      throw new AgenticApiError(
        "Agentic API returned an invalid response without a session ID",
        response.status,
        "INVALID_RESPONSE",
      );
    }

    if (data.status === "error" || data.status === "cancelled") {
      throw new AgenticApiError(
        data.error ?? `Agentic execution ${data.status}`,
        response.status,
        data.status === "error"
          ? "EXECUTION_ERROR"
          : "EXECUTION_CANCELLED",
      );
    }

    const completedOutput =
      data.response !== undefined
        ? data.response
        : formatAgentResult(data.result);
    if (
      data.status === "completed" ||
      (data.status === undefined && completedOutput !== undefined)
    ) {
      if (completedOutput === undefined) {
        throw new AgenticApiError(
          "Agentic API returned an invalid response without agent output",
          response.status,
          "INVALID_RESPONSE",
        );
      }
      return {
        kind: "completed",
        response: completedOutput,
        sessionId: returnedSessionId,
        ...(data.execution_id ? { executionId: data.execution_id } : {}),
      };
    }

    if (data.status === "suspended") {
      if (!data.execution_id) {
        throw new AgenticApiError(
          "Agentic API returned a suspended execution without an execution ID",
          response.status,
          "INVALID_RESPONSE",
        );
      }
      const interrupts = data.suspend_context?.interrupts;
      if (!interrupts?.length) {
        throw new AgenticApiError(
          "Agentic API returned a suspended execution without interrupt details",
          response.status,
          "INVALID_RESPONSE",
        );
      }
      return {
        kind: "suspended",
        sessionId: returnedSessionId,
        executionId: data.execution_id,
        interrupts: interrupts.map((interrupt) => ({
          id: interrupt.id,
          actionRequests: interrupt.value.actionRequests,
        })),
        ...(data.suspend_context?.resume_schema
          ? { resumeSchema: data.suspend_context.resume_schema }
          : {}),
      };
    }

    throw new AgenticApiError(
      `Agentic API returned unsupported execution status: ${data.status ?? "missing"}`,
      response.status,
      "INVALID_RESPONSE",
    );
  }

  private invokeUrl(): string {
    const projectId = encodeURIComponent(this.config.projectId);
    const workspaceId = encodeURIComponent(this.config.workspaceId);
    return `${this.config.baseUrl}/api/v1/projects/${projectId}/workspaces/${workspaceId}/invoke`;
  }
}

function formatAgentResult(result: unknown): string | undefined {
  if (result === undefined) {
    return undefined;
  }
  if (typeof result === "string") {
    return result;
  }
  if (result && typeof result === "object") {
    const value = result as Record<string, unknown>;
    if (typeof value.content === "string") {
      return value.content;
    }
    if (typeof value.response === "string") {
      return value.response;
    }
  }
  return JSON.stringify(result);
}
