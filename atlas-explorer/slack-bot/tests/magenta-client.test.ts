import { describe, expect, it, vi } from "vitest";

import {
  AgenticApiError,
  MagentaClient,
} from "../src/magenta/client.js";

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
        slackUserId: "U123",
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
      user_id: "U123",
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
        slackUserId: "U123",
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
        slackUserId: "U123",
      }),
    ).resolves.toEqual({
      kind: "completed",
      response: "There are three local projects.",
      sessionId: "local-session",
      executionId: "local-execution",
    });
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toEqual({
      message: "List projects",
      user_id: "U123",
      wait: true,
    });
    expect(fetchFn.mock.calls[0]?.[1]?.headers).toEqual({
      "Content-Type": "application/json",
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
      slackUserId: "U123",
      interruptId: "interrupt-1",
      decision: { type: "approve" },
    });

    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toEqual({
      session_id: "local-session",
      user_id: "U123",
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
      slackUserId: "U123",
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
      user_id: "U123",
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
        slackUserId: "U123",
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
      slackUserId: "U123",
    });

    const [, init] = fetchFn.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      session_id: "session-1",
      user_id: "U123",
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
      slackUserId: "U123",
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
      slackUserId: "U123",
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
          slackUserId: "U123",
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
      client.invoke({ message: "Hello", slackUserId: "U123" }),
    ).rejects.toThrow(/invalid response/i);
  });
});
