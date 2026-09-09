import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  handleUserMessage,
  publishInvocationResult,
} from "./handleUserMessage.js";
import {
  completed,
  FakeAgentGateway,
  FakePublisher,
  suspended,
} from "./handlers.test-helpers.js";
import { MemoryThreadStore } from "../store/memoryThreadStore.js";
import type { ThreadStore } from "../store/threadStore.js";

const TEST_NOW = Date.parse("2026-09-08T12:00:00.000Z");

describe("handleUserMessage", () => {
  let agent: FakeAgentGateway;
  let publisher: FakePublisher;
  let store: ThreadStore;

  beforeEach(() => {
    agent = new FakeAgentGateway();
    publisher = new FakePublisher();
    store = new MemoryThreadStore({ now: () => TEST_NOW });
  });

  it("starts a Magenta session and maps it to the Slack thread", async () => {
    agent.invokeResult = completed;

    await handleUserMessage(
      {
        channelId: "C123",
        threadTs: "1720000000.000100",
        slackUserId: "U123",
        text: "List projects",
      },
      { agent, publisher, store },
    );

    expect(agent.invokeInputs).toEqual([
      {
        message: "List projects",
        slackUserId: "U123",
      },
    ]);
    expect(publisher.statuses).toEqual(["Exploring Atlas…"]);
    expect(publisher.agentResponses).toEqual(["There are three projects."]);
    expect(
      await store.get("C123", "1720000000.000100"),
    ).toMatchObject({
      magentaSessionId: "session-1",
    });
  });

  it("shows streamed tool progress as transient statuses only", async () => {
    agent.invokeResult = completed;
    agent.progressEvents = [
      {
        content: "Thinking...",
        phase: "tool_start",
        toolName: "invoke_llm",
      },
      {
        content: "Calling tool: mongodb__atlas_list_projects...",
        phase: "tool_start",
        toolName: "mongodb__atlas_list_projects",
      },
      {
        content: "",
        phase: "tool_end",
        toolName: "mongodb__atlas_list_projects",
        status: "success",
      },
    ];

    await handleUserMessage(
      {
        channelId: "C123",
        threadTs: "1720000000.000100",
        slackUserId: "U123",
        text: "List projects",
      },
      { agent, publisher, store },
    );

    expect(publisher.statuses).toEqual([
      "Exploring Atlas…",
      "Thinking...",
      "Calling tool: mongodb__atlas_list_projects...",
    ]);
    expect(publisher.messages).toEqual([]);
    expect(publisher.agentResponses).toEqual(["There are three projects."]);
  });

  it("reuses the Magenta session for a Slack thread follow-up", async () => {
    await store.put({
      channelId: "C123",
      threadTs: "1720000000.000100",
      magentaSessionId: "session-1",
      updatedAt: new Date("2026-09-08T12:00:00.000Z"),
    });
    agent.invokeResult = {
      ...completed,
      response: "The first project has two clusters.",
      executionId: "execution-2",
    };

    await handleUserMessage(
      {
        channelId: "C123",
        threadTs: "1720000000.000100",
        slackUserId: "U123",
        text: "What about the first one?",
      },
      { agent, publisher, store },
    );

    expect(agent.invokeInputs[0]).toEqual({
      message: "What about the first one?",
      sessionId: "session-1",
      slackUserId: "U123",
    });
  });

  it("rejects users outside the configured Slack allowlist", async () => {
    agent.invokeResult = completed;

    await handleUserMessage(
      {
        channelId: "D123",
        threadTs: "1720000000.000100",
        slackUserId: "U123",
        text: "List projects",
      },
      {
        agent,
        publisher,
        store,
        authorizedSlackUserIds: new Set(["U456"]),
      },
    );

    expect(agent.invokeInputs).toEqual([]);
    expect(publisher.messages[0]?.text).toMatch(/not authorized/i);
  });

  it("blocks free-form messages while a review is pending", async () => {
    await store.put({
      channelId: "C123",
      threadTs: "1720000000.000100",
      magentaSessionId: "session-1",
      pendingExecutionId: "execution-2",
      pendingInterruptId: "interrupt-1",
      pendingActionRequests: [
        { name: "mongodb__insert_many", args: { count: 1 } },
      ],
      pendingRequestedBySlackUserId: "U123",
      updatedAt: new Date(),
    });

    await handleUserMessage(
      {
        channelId: "C123",
        threadTs: "1720000000.000100",
        slackUserId: "U123",
        text: "Are you done?",
      },
      { agent, publisher, store },
    );

    expect(agent.invokeInputs).toEqual([]);
    expect(publisher.messages[0]?.text).toMatch(/requires approval/i);
    expect(publisher.messages[0]?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "actions",
        }),
      ]),
    );
  });

  it("does not post duplicate controls while a review is resuming", async () => {
    await store.put({
      channelId: "C123",
      threadTs: "1720000000.000100",
      magentaSessionId: "session-1",
      pendingExecutionId: "execution-2",
      pendingInterruptId: "interrupt-1",
      pendingActionRequests: [
        { name: "mongodb__insert_many", args: { count: 1 } },
      ],
      pendingRequestedBySlackUserId: "U123",
      pendingReviewState: "resuming",
      pendingReviewClaimedAt: new Date(),
      updatedAt: new Date(),
    });

    await handleUserMessage(
      {
        channelId: "C123",
        threadTs: "1720000000.000100",
        eventId: "Ev-review-follow-up",
        slackUserId: "U123",
        text: "Did that run?",
      },
      { agent, publisher, store },
    );

    expect(publisher.messages[0]?.text).toMatch(/decision is being processed/i);
    expect(publisher.messages[0]?.blocks).toBeUndefined();
  });

  it("marks an abandoned review claim uncertain instead of replaying it", async () => {
    await store.put({
      channelId: "C123",
      threadTs: "1720000000.000100",
      magentaSessionId: "session-1",
      pendingExecutionId: "execution-2",
      pendingInterruptId: "interrupt-1",
      pendingActionRequests: [
        { name: "mongodb__insert_many", args: { count: 1 } },
      ],
      pendingRequestedBySlackUserId: "U123",
      pendingReviewState: "resuming",
      pendingReviewClaimedAt: new Date("2026-09-08T12:00:00.000Z"),
      updatedAt: new Date("2026-09-08T12:00:00.000Z"),
    });

    await handleUserMessage(
      {
        channelId: "C123",
        threadTs: "1720000000.000100",
        eventId: "Ev-stale-review",
        slackUserId: "U123",
        text: "Did that run?",
      },
      {
        agent,
        publisher,
        store,
        now: () => new Date("2026-09-08T12:20:00.000Z"),
      },
    );

    expect(publisher.messages[0]?.text).toMatch(/could not confirm/i);
    await expect(
      store.get("C123", "1720000000.000100"),
    ).resolves.toMatchObject({
      pendingReviewState: "uncertain",
    });
  });

  it("persists a suspended execution and renders approval controls", async () => {
    agent.invokeResult = suspended;

    await handleUserMessage(
      {
        channelId: "C123",
        threadTs: "1720000000.000100",
        slackUserId: "U123",
        text: "Insert an inventory item",
      },
      { agent, publisher, store },
    );

    expect(
      await store.get("C123", "1720000000.000100"),
    ).toMatchObject({
      magentaSessionId: "session-1",
      pendingExecutionId: "execution-2",
      pendingInterruptId: "interrupt-1",
      pendingRequestedBySlackUserId: "U123",
      pendingActionRequests: suspended.interrupts[0]?.actionRequests,
    });
    expect(publisher.messages[0]?.text).toMatch(
      /mongodb__insert_many.*approval/s,
    );
    expect(
      publisher.messages[0]?.blocks?.flatMap((block) =>
        block.type === "actions" ? block.elements : [],
      ),
    ).toMatchObject([
      { action_id: "atlas_explorer_review_approve", value: expect.any(String) },
      { action_id: "atlas_explorer_review_reject", value: expect.any(String) },
    ]);
  });

  it("deduplicates a retried Slack event", async () => {
    agent.invokeResult = completed;
    const input = {
      channelId: "D123",
      threadTs: "1720000000.000100",
      eventId: "Ev123",
      slackUserId: "U123",
      text: "List projects",
    };

    await handleUserMessage(input, {
      agent,
      publisher,
      store,
      now: () => new Date("2026-09-08T12:00:00.000Z"),
    });
    await handleUserMessage(input, {
      agent,
      publisher,
      store,
      now: () => new Date("2026-09-08T12:00:00.000Z"),
    });

    expect(agent.invokeInputs).toHaveLength(1);
    expect(publisher.agentResponses).toHaveLength(1);
  });

  it("retries a durably stored response after Slack delivery fails", async () => {
    agent.invokeResult = completed;
    publisher.agentResponseError = new Error("Slack response was lost");
    const input = {
      channelId: "D123",
      threadTs: "1720000000.000100",
      eventId: "Ev-delivery-retry",
      slackUserId: "U123",
      text: "List projects",
    };

    await handleUserMessage(input, {
      agent,
      publisher,
      store,
      now: () => new Date("2026-09-08T12:00:00.000Z"),
    });
    await expect(
      store.get(input.channelId, input.threadTs),
    ).resolves.toMatchObject({
      pendingDelivery: {
        id: input.eventId,
        text: completed.response,
      },
    });

    publisher.agentResponseError = undefined;
    await handleUserMessage(input, {
      agent,
      publisher,
      store,
      now: () => new Date("2026-09-08T12:06:00.000Z"),
    });

    expect(agent.invokeInputs).toHaveLength(1);
    expect(publisher.agentResponses).toEqual([completed.response]);
    await expect(
      store.get(input.channelId, input.threadTs),
    ).resolves.toEqual(
      expect.not.objectContaining({
        pendingDelivery: expect.anything(),
      }),
    );
  });

  it("does not duplicate a response Slack accepted before losing its reply", async () => {
    agent.invokeResult = completed;
    publisher.agentResponseError = new Error("Slack response was lost");
    publisher.acceptAgentResponseBeforeError = true;
    const input = {
      channelId: "D123",
      threadTs: "1720000000.000100",
      eventId: "Ev-accepted-response",
      slackUserId: "U123",
      text: "List projects",
    };

    await handleUserMessage(input, {
      agent,
      publisher,
      store,
      now: () => new Date("2026-09-08T12:00:00.000Z"),
    });
    publisher.agentResponseError = undefined;
    await handleUserMessage(input, {
      agent,
      publisher,
      store,
      now: () => new Date("2026-09-08T12:06:00.000Z"),
    });

    expect(publisher.agentResponseAttempts).toBe(1);
    expect(publisher.agentResponses).toEqual([completed.response]);
    await expect(
      store.get(input.channelId, input.threadTs),
    ).resolves.toEqual(
      expect.not.objectContaining({
        pendingDelivery: expect.anything(),
      }),
    );
  });

  it("allows only one concurrent sender for a pending response", async () => {
    agent.invokeResult = completed;
    let releaseDelivery!: () => void;
    publisher.agentResponseGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const input = {
      channelId: "D123",
      threadTs: "1720000000.000100",
      eventId: "Ev-concurrent-delivery",
      slackUserId: "U123",
      text: "List projects",
    };

    const original = handleUserMessage(input, {
      agent,
      publisher,
      store,
    });
    await vi.waitFor(() => {
      expect(publisher.agentResponseAttempts).toBe(1);
    });
    await handleUserMessage(input, { agent, publisher, store });
    expect(publisher.agentResponseAttempts).toBe(1);

    releaseDelivery();
    await original;
    expect(publisher.agentResponses).toEqual([completed.response]);
  });

  it("serializes concurrent messages in one Slack thread", async () => {
    agent.invokeResult = completed;
    const first = handleUserMessage(
      {
        channelId: "D123",
        threadTs: "1720000000.000100",
        eventId: "Ev123",
        slackUserId: "U123",
        text: "List projects",
      },
      { agent, publisher, store },
    );
    const second = handleUserMessage(
      {
        channelId: "D123",
        threadTs: "1720000000.000100",
        eventId: "Ev124",
        slackUserId: "U123",
        text: "What about the first one?",
      },
      { agent, publisher, store },
    );

    await Promise.all([first, second]);

    expect(agent.invokeInputs).toHaveLength(1);
    expect(publisher.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringMatching(/already working/i) }),
      ]),
    );
  });

  it("discards a result from a replaced turn lease", async () => {
    await store.put({
      channelId: "D123",
      threadTs: "1720000000.000100",
      inFlightEventId: "Ev-new",
      inFlightStartedAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      publishInvocationResult(
        {
          channelId: "D123",
          threadTs: "1720000000.000100",
          slackUserId: "U123",
        },
        completed,
        { agent, publisher, store },
        { kind: "turn", eventId: "Ev-old" },
      ),
    ).resolves.toBe(false);
    expect(publisher.agentResponses).toEqual([]);
    await expect(
      store.get("D123", "1720000000.000100"),
    ).resolves.toMatchObject({
      inFlightEventId: "Ev-new",
    });
  });
});
