import type {
  AgenticClientConfig,
  InvocationProgressHandler,
  InvocationResult,
  InvokeInput,
  ResumeInput,
} from "./types.js";
import {
  invokeResponseSchema,
  streamChunkSchema,
  suspendContextSchema,
} from "./types.js";

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

  invokeStream(
    input: InvokeInput,
    onProgress?: InvocationProgressHandler,
  ): Promise<InvocationResult> {
    const message = input.message.trim();
    if (!message) {
      return Promise.reject(
        new AgenticApiError("Agent message cannot be empty", 0, "INVALID_INPUT"),
      );
    }
    return this.stream(
      {
        message,
        ...(input.sessionId ? { session_id: input.sessionId } : {}),
        user_id: input.slackUserId,
      },
      onProgress,
    );
  }

  resume(input: ResumeInput): Promise<InvocationResult> {
    return this.post({
      session_id: input.sessionId,
      user_id: input.slackUserId,
      ...(this.config.invokeTarget === "local" ? { wait: true } : {}),
      resume_map: buildResumeMap(input),
    });
  }

  resumeStream(
    input: ResumeInput,
    onProgress?: InvocationProgressHandler,
  ): Promise<InvocationResult> {
    return this.stream(
      {
        session_id: input.sessionId,
        user_id: input.slackUserId,
        resume_map: buildResumeMap(input),
      },
      onProgress,
    );
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
        interrupts,
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

  private async stream(
    body: Record<string, unknown>,
    onProgress?: InvocationProgressHandler,
  ): Promise<InvocationResult> {
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
      response = await this.fetchFn(this.invokeStreamUrl(), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Agentic stream failed";
      throw new AgenticApiError(message, 0, "REQUEST_FAILED");
    }

    if (!response.ok) {
      const rawBody = await response.text();
      let errorBody: {
        error?: string;
        message?: string;
        detail?: string;
        code?: string;
      } = {};
      try {
        errorBody = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        throw new AgenticApiError(
          `Agentic API returned non-JSON content (HTTP ${response.status})`,
          response.status,
          "INVALID_RESPONSE",
        );
      }
      throw new AgenticApiError(
        errorBody.error ??
          errorBody.message ??
          errorBody.detail ??
          `Agentic stream failed (HTTP ${response.status})`,
        response.status,
        errorBody.code,
      );
    }

    const returnedSessionId =
      response.headers.get("X-Session-ID") ?? sessionId;

    let executionId: string | undefined;
    let finalContent: string | undefined;
    let streamedContent = "";
    let completed = false;
    let suspendedContext: unknown;
    for await (const data of readSseData(response)) {
      const parsed = streamChunkSchema.safeParse(data);
      if (!parsed.success) {
        throw new AgenticApiError(
          "Agentic stream returned an invalid event",
          response.status,
          "INVALID_RESPONSE",
        );
      }
      const chunk = parsed.data;
      executionId ??=
        chunk.execution_id || chunk.metadata.execution_id || undefined;
      if (chunk.chunk_type === "progress") {
        await onProgress?.({
          content: chunk.content,
          phase: chunk.metadata.phase,
          toolName: chunk.metadata.tool_name,
          status: chunk.metadata.status,
        });
      } else if (chunk.chunk_type === "text") {
        streamedContent += chunk.content;
      } else if (chunk.chunk_type === "done") {
        if (chunk.metadata.status === "suspended") {
          const rawContext = chunk.metadata.suspend_context;
          try {
            suspendedContext = rawContext ? JSON.parse(rawContext) : undefined;
          } catch {
            throw new AgenticApiError(
              "Agentic stream returned malformed suspend context",
              response.status,
              "INVALID_RESPONSE",
            );
          }
        } else {
          completed = true;
          finalContent = chunk.content || streamedContent;
        }
      }
      if (chunk.error) {
        throw new AgenticApiError(
          chunk.error,
          response.status,
          chunk.code ?? "EXECUTION_ERROR",
        );
      }
    }

    if (!returnedSessionId) {
      throw new AgenticApiError(
        "Agentic stream returned an invalid response without a session ID",
        response.status,
        "INVALID_RESPONSE",
      );
    }
    if (suspendedContext !== undefined) {
      const parsedContext = suspendContextSchema.safeParse(suspendedContext);
      if (!executionId || !parsedContext.success) {
        throw new AgenticApiError(
          "Agentic stream returned invalid interrupt details",
          response.status,
          "INVALID_RESPONSE",
        );
      }
      return {
        kind: "suspended",
        sessionId: returnedSessionId,
        executionId,
        interrupts: parsedContext.data.interrupts,
        ...(parsedContext.data.resume_schema
          ? { resumeSchema: parsedContext.data.resume_schema }
          : {}),
      };
    }
    if (!completed || finalContent === undefined) {
      throw new AgenticApiError(
        "Agentic stream ended without a completed result",
        response.status,
        "INVALID_RESPONSE",
      );
    }
    return {
      kind: "completed",
      response: finalContent,
      sessionId: returnedSessionId,
      ...(executionId ? { executionId } : {}),
    };
  }

  private invokeUrl(): string {
    if (this.config.invokeTarget === "local") {
      return `${this.config.baseUrl}/invoke`;
    }
    const projectId = encodeURIComponent(this.config.projectId);
    const workspaceId = encodeURIComponent(this.config.workspaceId);
    return `${this.config.baseUrl}/api/v1/projects/${projectId}/workspaces/${workspaceId}/invoke`;
  }

  private invokeStreamUrl(): string {
    if (this.config.invokeTarget === "local") {
      return `${this.config.baseUrl}/invoke/stream`;
    }
    const projectId = encodeURIComponent(this.config.projectId);
    const workspaceId = encodeURIComponent(this.config.workspaceId);
    return `${this.config.baseUrl}/api/v1/projects/${projectId}/workspaces/${workspaceId}/invokeStream`;
  }
}

function buildResumeMap(input: ResumeInput): Record<string, unknown> {
  const decisions = Array.isArray(input.decision)
    ? input.decision
    : [input.decision];
  return Object.fromEntries(
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
}

async function* readSseData(
  response: Response,
): AsyncGenerator<unknown, void, undefined> {
  if (!response.body) {
    throw new AgenticApiError(
      "Agentic stream returned an empty response body",
      response.status,
      "INVALID_RESPONSE",
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let lineEnd = buffer.indexOf("\n");
    while (lineEnd >= 0) {
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      if (line.startsWith("data:")) {
        const data = line.slice("data:".length).trim();
        if (data && data !== "[DONE]") {
          try {
            yield JSON.parse(data);
          } catch {
            throw new AgenticApiError(
              "Agentic stream returned malformed JSON",
              response.status,
              "INVALID_RESPONSE",
            );
          }
        }
      }
      lineEnd = buffer.indexOf("\n");
    }
    if (done) {
      break;
    }
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
