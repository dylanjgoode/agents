import { describe, expect, it, vi } from "vitest";

import {
  AgenticApiError,
  MagentaClient,
} from "./client.js";

const config = {
  baseUrl: "https://agentic.example.test/",
  apiKey: "agp_test",
  projectId: "project/id",
  workspaceId: "workspace id",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function streamResponse(
  chunks: unknown[],
  sessionId: string | null = "stream-session",
): Response {
  const headers: Record<string, string> = {
    "content-type": "text/event-stream",
  };
  if (sessionId) {
    headers["X-Session-ID"] = sessionId;
  }
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""),
    {
      status: 200,
      headers,
    },
  );
}

describe("MagentaClient", () => {
  it("invokes Atlas Explorer and returns its session", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        success: true,
        response: "There are three projects.",
        session_id: "session-1",
        execution_id: "execution-1",
        status: "completed",
      }),
    );
    const client = new MagentaClient(config, { fetchFn });

    await expect(
      client.invoke({
        message: "List projects",
        actorId: "slack:U123",
      }),
    ).resolves.toEqual({
      kind: "completed",
      response: "There are three projects.",
      sessionId: "session-1",
      executionId: "execution-1",
    });

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(
      "https://agentic.example.test/api/v1/projects/project%2Fid/workspaces/workspace%20id/invoke",
    );
    expect(init?.headers).toEqual({
      Authorization: "Bearer agp_test",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      message: "List projects",
      user_id: "slack:U123",
    });
  });

  it("accepts the minimal successful response emitted by Agentic CLI", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          response: "There are three projects.",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "X-Session-ID": "session-from-header",
          },
        },
      ),
    );
    const client = new MagentaClient(config, { fetchFn });

    await expect(
      client.invoke({
        message: "List projects",
        actorId: "slack:U123",
      }),
    ).resolves.toEqual({
      kind: "completed",
      response: "There are three projects.",
      sessionId: "session-from-header",
    });
  });

  it("uses the blocking local Playground proxy contract", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        result: { content: "There are three local projects." },
        session_id: "local-session",
        execution_id: "local-execution",
        status: "completed",
      }),
    );
    const client = new MagentaClient(
      {
        baseUrl: "http://localhost:3000",
        projectId: "local",
        workspaceId: "local",
        invokeTarget: "local",
      },
      { fetchFn },
    );

    await expect(
      client.invoke({
        message: "List projects",
        actorId: "slack:U123",
      }),
    ).resolves.toEqual({
      kind: "completed",
      response: "There are three local projects.",
      sessionId: "local-session",
      executionId: "local-execution",
    });
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      "http://localhost:3000/invoke",
    );
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toEqual({
      message: "List projects",
      user_id: "slack:U123",
      wait: true,
    });
    expect(fetchFn.mock.calls[0]?.[1]?.headers).toEqual({
      "Content-Type": "application/json",
    });
  });

  it("streams local tool progress and returns only the collected final message", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      streamResponse([
        {
          chunk_type: "metadata",
          metadata: { status: "started" },
          execution_id: "stream-execution",
        },
        {
          chunk_type: "progress",
          content: "Calling tool: mongodb__atlas_list_projects...",
          metadata: {
            phase: "tool_start",
            tool_name: "mongodb__atlas_list_projects",
          },
          execution_id: "stream-execution",
        },
        {
          chunk_type: "text",
          content: "partial text that is not published independently",
          execution_id: "stream-execution",
        },
        {
          chunk_type: "done",
          content: "There are three projects.",
          metadata: { status: "completed" },
          execution_id: "stream-execution",
        },
      ]),
    );
    const client = new MagentaClient(
      {
        baseUrl: "http://localhost:3000",
        projectId: "local",
        workspaceId: "local",
        invokeTarget: "local",
      },
      { fetchFn },
    );
    const progress: unknown[] = [];

    await expect(
      client.invokeStream(
        { message: "List projects", actorId: "slack:U123" },
        (event) => {
          progress.push(event);
        },
      ),
    ).resolves.toEqual({
      kind: "completed",
      response: "There are three projects.",
      sessionId: "stream-session",
      executionId: "stream-execution",
    });
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      "http://localhost:3000/invoke/stream",
    );
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toEqual({
      message: "List projects",
      user_id: "slack:U123",
    });
    expect(progress).toEqual([
      {
        content: "Calling tool: mongodb__atlas_list_projects...",
        phase: "tool_start",
        toolName: "mongodb__atlas_list_projects",
        status: undefined,
      },
    ]);
  });

  it("uses the deployed gateway invokeStream route", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      streamResponse(
        [
          {
            chunk_type: "done",
            content: "Gateway response.",
            metadata: { status: "completed" },
            execution_id: "gateway-execution",
          },
        ],
        "gateway-session",
      ),
    );
    const client = new MagentaClient(config, { fetchFn });

    await client.invokeStream(
      { message: "List projects", actorId: "slack:U123" },
      () => undefined,
    );

    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      "https://agentic.example.test/api/v1/projects/project%2Fid/workspaces/workspace%20id/invokeStream",
    );
  });

  it("returns an agent interrupt from a suspended stream", async () => {
    const suspendContext = {
      interrupts: [
        {
          id: "interrupt-1",
          value: {
            actionRequests: [
              {
                name: "mongodb__insert_many",
                args: { database: "inventory", collection: "items" },
              },
            ],
          },
        },
      ],
      resume_schema: { type: "object" },
    };
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      streamResponse([
        {
          chunk_type: "done",
          metadata: {
            status: "suspended",
            execution_id: "suspended-execution",
            suspend_context: JSON.stringify(suspendContext),
          },
        },
      ]),
    );
    const client = new MagentaClient(config, { fetchFn });

    await expect(
      client.invokeStream(
        { message: "Insert an item", actorId: "slack:U123" },
        () => undefined,
      ),
    ).resolves.toEqual({
      kind: "suspended",
      sessionId: "stream-session",
      executionId: "suspended-execution",
      interrupts: [
        {
          id: "interrupt-1",
          actionRequests: [
            {
              name: "mongodb__insert_many",
              args: { database: "inventory", collection: "items" },
            },
          ],
        },
      ],
      resumeSchema: { type: "object" },
    });
  });

  it("surfaces a streamed execution error", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      streamResponse(
        [
          {
            chunk_type: "error",
            error: "LLM provider unavailable",
            code: "LLM_UNAVAILABLE",
          },
        ],
        null,
      ),
    );
    const client = new MagentaClient(config, { fetchFn });

    await expect(
      client.invokeStream(
        { message: "List projects", actorId: "slack:U123" },
        () => undefined,
      ),
    ).rejects.toMatchObject({
      name: "AgenticApiError",
      code: "LLM_UNAVAILABLE",
      message: "LLM provider unavailable",
    });
  });

  it("resumes an interrupt through the local stream", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      streamResponse([
        {
          chunk_type: "done",
          content: "Operation completed.",
          metadata: { status: "completed" },
          execution_id: "resumed-execution",
        },
      ]),
    );
    const client = new MagentaClient(
      {
        baseUrl: "http://localhost:3000",
        projectId: "local",
        workspaceId: "local",
        invokeTarget: "local",
      },
      { fetchFn },
    );

    await client.resumeStream(
      {
        sessionId: "stream-session",
        actorId: "slack:U123",
        interruptId: "interrupt-1",
        decision: { type: "approve" },
      },
      () => undefined,
    );

    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      "http://localhost:3000/invoke/stream",
    );
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toEqual({
      session_id: "stream-session",
      user_id: "slack:U123",
      resume_map: {
        "interrupt-1": {
          decisions: [{ type: "approve" }],
        },
      },
    });
  });

  it("resumes a local interrupt through the blocking invoke route", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        result: "Local mutation completed.",
        session_id: "local-session",
        execution_id: "local-execution",
        status: "completed",
      }),
    );
    const client = new MagentaClient(
      {
        baseUrl: "http://localhost:3000",
        projectId: "local",
        workspaceId: "local",
        invokeTarget: "local",
      },
      { fetchFn },
    );

    await client.resume({
      sessionId: "local-session",
      actorId: "slack:U123",
      interruptId: "interrupt-1",
      decision: { type: "approve" },
    });

    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toEqual({
      session_id: "local-session",
      user_id: "slack:U123",
      wait: true,
      resume_map: {
        "interrupt-1": {
          decisions: [{ type: "approve" }],
        },
      },
    });
  });

  it("sends the stored session in the body and continuity header", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        success: true,
        response: "The first one has two clusters.",
        session_id: "session-1",
        execution_id: "execution-2",
        status: "completed",
      }),
    );
    const client = new MagentaClient(config, { fetchFn });

    await client.invoke({
      message: "What about the first one?",
      sessionId: "session-1",
      actorId: "slack:U123",
    });

    const [, init] = fetchFn.mock.calls[0]!;
    expect(init?.headers).toEqual({
      Authorization: "Bearer agp_test",
      "Content-Type": "application/json",
      "X-Session-ID": "session-1",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      message: "What about the first one?",
      session_id: "session-1",
      user_id: "slack:U123",
    });
  });

  it("returns a validated agent interrupt when execution suspends", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        success: true,
        session_id: "session-1",
        execution_id: "execution-3",
        status: "suspended",
        suspend_context: {
          interrupts: [
            {
              id: "interrupt-1",
              value: {
                actionRequests: [
                  {
                    name: "mongodb__insert_many",
                    args: {
                      database: "inventory",
                      collection: "items",
                      documents: [{ sku: "A-1" }],
                    },
                    description:
                      "MongoDB or Atlas operation pending approval",
                  },
                ],
                reviewConfigs: [
                  {
                    actionName: "mongodb__insert_many",
                    allowedDecisions: ["approve", "edit", "reject"],
                  },
                ],
              },
            },
          ],
          resume_schema: { type: "object" },
        },
      }),
    );
    const client = new MagentaClient(config, { fetchFn });

    await expect(
      client.invoke({
        message: "Insert this item",
        actorId: "slack:U123",
      }),
    ).resolves.toEqual({
      kind: "suspended",
      sessionId: "session-1",
      executionId: "execution-3",
      interrupts: [
        {
          id: "interrupt-1",
          actionRequests: [
            {
              name: "mongodb__insert_many",
              args: {
                database: "inventory",
                collection: "items",
                documents: [{ sku: "A-1" }],
              },
              description: "MongoDB or Atlas operation pending approval",
            },
          ],
        },
      ],
      resumeSchema: { type: "object" },
    });
  });

  it("resumes an interrupt without adding an empty user message", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        success: true,
        response: "The operation was approved and completed.",
        session_id: "session-1",
        execution_id: "execution-4",
        status: "completed",
      }),
    );
    const client = new MagentaClient(config, { fetchFn });

    await client.resume({
      sessionId: "session-1",
      interruptId: "interrupt-1",
      decision: { type: "approve" },
      actorId: "slack:U123",
    });

    const [, init] = fetchFn.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      session_id: "session-1",
      user_id: "slack:U123",
      resume_map: {
        "interrupt-1": {
          decisions: [{ type: "approve" }],
        },
      },
    });
  });

  it("answers every simultaneously pending interrupt in one resume map", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        success: true,
        response: "Both operations completed.",
        session_id: "session-1",
      }),
    );
    const client = new MagentaClient(config, { fetchFn });

    await client.resume({
      sessionId: "session-1",
      interruptId: "interrupt-1",
      decision: { type: "approve" },
      additionalInterrupts: [
        {
          interruptId: "interrupt-2",
          decision: [
            {
              type: "reject",
              message: "The Slack user rejected this operation.",
            },
          ],
        },
      ],
      actorId: "slack:U123",
    });

    const [, init] = fetchFn.mock.calls[0]!;
    expect(JSON.parse(String(init?.body)).resume_map).toEqual({
      "interrupt-1": { decisions: [{ type: "approve" }] },
      "interrupt-2": {
        decisions: [
          {
            type: "reject",
            message: "The Slack user rejected this operation.",
          },
        ],
      },
    });
  });

  it("surfaces the Agentic error code from a failed request", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          success: false,
          code: "SESSION_BUSY",
          error: "session has pending interrupts",
        },
        409,
      ),
    );
    const client = new MagentaClient(config, { fetchFn });

    const request = client.invoke({
      message: "Another request",
      sessionId: "session-1",
      actorId: "slack:U123",
    });

    await expect(request).rejects.toMatchObject<Partial<AgenticApiError>>({
      name: "AgenticApiError",
      status: 409,
      code: "SESSION_BUSY",
      message: "session has pending interrupts",
    });
  });

  it.each([
    ["error", "EXECUTION_ERROR"],
    ["cancelled", "EXECUTION_CANCELLED"],
  ] as const)(
    "treats a terminal %s execution as a failed invocation",
    async (status, expectedCode) => {
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          success: true,
          error: `Execution ${status}`,
          session_id: "session-1",
          execution_id: "execution-5",
          status,
        }),
      );
      const client = new MagentaClient(config, { fetchFn });

      await expect(
        client.invoke({
          message: "List projects",
          actorId: "slack:U123",
        }),
      ).rejects.toMatchObject({
        name: "AgenticApiError",
        code: expectedCode,
        message: `Execution ${status}`,
      });
    },
  );

  it("rejects malformed successful responses instead of losing the session", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ success: true, status: "completed" }));
    const client = new MagentaClient(config, { fetchFn });

    await expect(
      client.invoke({ message: "Hello", actorId: "slack:U123" }),
    ).rejects.toThrow(/invalid response/i);
  });
});
