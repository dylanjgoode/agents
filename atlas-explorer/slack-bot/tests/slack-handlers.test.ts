import type { KnownBlock } from "@slack/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  InvocationResult,
  InvokeInput,
  ResumeInput,
} from "../src/magenta/types.js";
import { AgenticApiError } from "../src/magenta/client.js";
import { handleReviewDecision } from "../src/slack/handleReviewAction.js";
import {
  handleUserMessage,
  publishInvocationResult,
  type AgentGateway,
  type SlackPublisher,
} from "../src/slack/handleUserMessage.js";
import { MemoryThreadStore } from "../src/store/memoryThreadStore.js";
import type { ThreadStore } from "../src/store/threadStore.js";

class FakeAgentGateway implements AgentGateway {
  invokeInputs: InvokeInput[] = [];
  resumeInputs: ResumeInput[] = [];
  invokeResult!: InvocationResult;
  resumeResult!: InvocationResult;
  resumeError?: unknown;

  async invoke(input: InvokeInput): Promise<InvocationResult> {
    this.invokeInputs.push(input);
    return this.invokeResult;
  }

  async resume(input: ResumeInput): Promise<InvocationResult> {
    this.resumeInputs.push(input);
    if (this.resumeError) {
      throw this.resumeError;
    }
    return this.resumeResult;
  }
}

class FakePublisher implements SlackPublisher {
  statuses: string[] = [];
  messages: Array<{ text: string; blocks?: KnownBlock[] }> = [];
  agentResponses: string[] = [];
  agentResponseDeliveryIds = new Set<string>();
  agentResponseAttempts = 0;
  agentResponseError?: Error;
  acceptAgentResponseBeforeError = false;
  agentResponseGate?: Promise<void>;
  updateReviewStatus?: SlackPublisher["updateReviewStatus"];

  async setStatus(status: string): Promise<void> {
    this.statuses.push(status);
  }

  async postMessage(message: {
    text: string;
    blocks?: KnownBlock[];
  }): Promise<void> {
    this.messages.push(message);
  }

  async postAgentResponse(
    text: string,
    deliveryId: string,
  ): Promise<void> {
    this.agentResponseAttempts += 1;
    await this.agentResponseGate;
    if (this.agentResponseError) {
      if (this.acceptAgentResponseBeforeError) {
        this.agentResponses.push(text);
        this.agentResponseDeliveryIds.add(deliveryId);
      }
      throw this.agentResponseError;
    }
    this.agentResponses.push(text);
    this.agentResponseDeliveryIds.add(deliveryId);
  }

  async hasAgentResponse(deliveryId: string): Promise<boolean> {
    return this.agentResponseDeliveryIds.has(deliveryId);
  }
}

const completed: InvocationResult = {
  kind: "completed",
  response: "There are three projects.",
  sessionId: "session-1",
  executionId: "execution-1",
};

const suspended: InvocationResult = {
  kind: "suspended",
  sessionId: "session-1",
  executionId: "execution-2",
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
};

describe("Slack conversation handlers", () => {
  let agent: FakeAgentGateway;
  let publisher: FakePublisher;
  let store: ThreadStore;

  beforeEach(() => {
    agent = new FakeAgentGateway();
    publisher = new FakePublisher();
    store = new MemoryThreadStore();
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

  it("approves every action and clears pending review state", async () => {
    await seedPendingReview(store);
    agent.resumeResult = {
      ...completed,
      response: "The item was inserted.",
      executionId: "execution-3",
    };

    const outcome = await handleReviewDecision(
      {
        channelId: "C123",
        threadTs: "1720000000.000100",
        interruptId: "interrupt-1",
        slackUserId: "U123",
        decision: "approve",
      },
      { agent, publisher, store },
    );

    expect(outcome).toBe("completed");
    expect(agent.resumeInputs).toEqual([
      {
        sessionId: "session-1",
        interruptId: "interrupt-1",
        decision: [{ type: "approve" }, { type: "approve" }],
        slackUserId: "U123",
      },
    ]);
    expect(
      await store.get("C123", "1720000000.000100"),
    ).toEqual(
      expect.not.objectContaining({
        pendingInterruptId: expect.anything(),
      }),
    );
    expect(publisher.agentResponses).toEqual(["The item was inserted."]);
  });

  it("rejects every action with feedback for the model", async () => {
    await seedPendingReview(store);
    agent.resumeResult = {
      ...completed,
      response: "I did not make the requested changes.",
      executionId: "execution-3",
    };

    await handleReviewDecision(
      {
        channelId: "C123",
        threadTs: "1720000000.000100",
        interruptId: "interrupt-1",
        slackUserId: "U123",
        decision: "reject",
      },
      { agent, publisher, store },
    );

    expect(agent.resumeInputs[0]?.decision).toEqual([
      { type: "reject", message: "The Slack user rejected this operation." },
      { type: "reject", message: "The Slack user rejected this operation." },
    ]);
  });

  it("resumes every simultaneously pending interrupt", async () => {
    agent.invokeResult = {
      kind: "suspended",
      sessionId: "session-1",
      executionId: "execution-2",
      interrupts: [
        {
          id: "interrupt-1",
          actionRequests: [
            { name: "mongodb__insert_many", args: { count: 1 } },
          ],
        },
        {
          id: "interrupt-2",
          actionRequests: [
            { name: "mongodb__create_index", args: { name: "sku_1" } },
          ],
        },
      ],
    };
    await handleUserMessage(
      {
        channelId: "C123",
        threadTs: "1720000000.000100",
        eventId: "Ev-multi-review",
        slackUserId: "U123",
        text: "Apply both changes",
      },
      { agent, publisher, store },
    );
    agent.resumeResult = completed;

    await handleReviewDecision(
      {
        channelId: "C123",
        threadTs: "1720000000.000100",
        interruptId: "interrupt-1",
        slackUserId: "U123",
        decision: "approve",
      },
      { agent, publisher, store },
    );

    expect(agent.resumeInputs[0]).toMatchObject({
      interruptId: "interrupt-1",
      decision: [{ type: "approve" }],
      additionalInterrupts: [
        {
          interruptId: "interrupt-2",
          decision: [{ type: "approve" }],
        },
      ],
    });
  });

  it("does not let another Slack user decide a pending mutation", async () => {
    await seedPendingReview(store);

    const outcome = await handleReviewDecision(
      {
        channelId: "C123",
        threadTs: "1720000000.000100",
        interruptId: "interrupt-1",
        slackUserId: "U999",
        decision: "approve",
      },
      { agent, publisher, store },
    );

    expect(outcome).toBe("unauthorized");
    expect(agent.resumeInputs).toEqual([]);
    expect(publisher.messages[0]?.text).toMatch(/only the requester/i);
  });

  it("rejects review actions from users outside the allowlist", async () => {
    await seedPendingReview(store);

    const outcome = await handleReviewDecision(
      {
        channelId: "C123",
        threadTs: "1720000000.000100",
        interruptId: "interrupt-1",
        slackUserId: "U123",
        decision: "approve",
      },
      {
        agent,
        publisher,
        store,
        authorizedSlackUserIds: new Set(["U456"]),
      },
    );

    expect(outcome).toBe("unauthorized");
    expect(agent.resumeInputs).toEqual([]);
    expect(publisher.messages[0]?.text).toMatch(/not authorized/i);
  });

  it("keeps the Magenta session advanced if the review message cannot update", async () => {
    await seedPendingReview(store);
    agent.resumeResult = {
      ...completed,
      response: "The item was inserted.",
      executionId: "execution-3",
    };
    publisher.updateReviewStatus = async () => {
      throw new Error("Slack update failed");
    };

    const outcome = await handleReviewDecision(
      {
        channelId: "C123",
        threadTs: "1720000000.000100",
        interruptId: "interrupt-1",
        slackUserId: "U123",
        decision: "approve",
      },
      { agent, publisher, store },
    );

    expect(outcome).toBe("completed");
    expect(
      await store.get("C123", "1720000000.000100"),
    ).toEqual(
      expect.not.objectContaining({
        pendingInterruptId: expect.anything(),
      }),
    );
  });

  it("does not let a stale button decide a newer interrupt", async () => {
    await seedPendingReview(store);

    const outcome = await handleReviewDecision(
      {
        channelId: "C123",
        threadTs: "1720000000.000100",
        interruptId: "interrupt-old",
        slackUserId: "U123",
        decision: "approve",
      },
      { agent, publisher, store },
    );

    expect(outcome).toBe("missing");
    expect(agent.resumeInputs).toEqual([]);
  });

  it("allows only one concurrent decision to resume an interrupt", async () => {
    await seedPendingReview(store);
    agent.resumeResult = {
      ...completed,
      response: "The item was inserted.",
      executionId: "execution-3",
    };
    const decision = {
      channelId: "C123",
      threadTs: "1720000000.000100",
      interruptId: "interrupt-1",
      slackUserId: "U123",
      decision: "approve" as const,
    };

    const outcomes = await Promise.all([
      handleReviewDecision(decision, { agent, publisher, store }),
      handleReviewDecision(decision, { agent, publisher, store }),
    ]);

    expect(agent.resumeInputs).toHaveLength(1);
    expect(outcomes).toContain("completed");
    expect(outcomes).toContain("missing");
  });

  it("marks a review uncertain when the resume response is lost", async () => {
    await seedPendingReview(store);
    agent.resumeError = new AgenticApiError(
      "The request timed out",
      0,
      "REQUEST_FAILED",
    );

    const outcome = await handleReviewDecision(
      {
        channelId: "C123",
        threadTs: "1720000000.000100",
        interruptId: "interrupt-1",
        slackUserId: "U123",
        decision: "approve",
      },
      { agent, publisher, store },
    );

    expect(outcome).toBe("uncertain");
    expect(
      await store.get("C123", "1720000000.000100"),
    ).toMatchObject({
      pendingInterruptId: "interrupt-1",
      pendingReviewState: "uncertain",
    });
    expect(publisher.messages[0]?.text).toMatch(/could not confirm/i);
    expect(publisher.messages[0]?.text).not.toMatch(/still pending/i);
  });

  it("treats an ambiguous session-busy resume response as uncertain", async () => {
    await seedPendingReview(store);
    agent.resumeError = new AgenticApiError(
      "session has pending interrupts",
      409,
      "SESSION_BUSY",
    );

    const outcome = await handleReviewDecision(
      {
        channelId: "C123",
        threadTs: "1720000000.000100",
        interruptId: "interrupt-1",
        slackUserId: "U123",
        decision: "approve",
      },
      { agent, publisher, store },
    );

    expect(outcome).toBe("uncertain");
    await expect(
      store.get("C123", "1720000000.000100"),
    ).resolves.toMatchObject({
      pendingReviewState: "uncertain",
    });
  });

  it("keeps controls pending after a confirmed invalid resume payload", async () => {
    await seedPendingReview(store);
    agent.resumeError = new AgenticApiError(
      "invalid resume map",
      409,
      "RESUME_INPUT_INVALID",
    );

    const outcome = await handleReviewDecision(
      {
        channelId: "C123",
        threadTs: "1720000000.000100",
        interruptId: "interrupt-1",
        slackUserId: "U123",
        decision: "approve",
      },
      { agent, publisher, store },
    );

    expect(outcome).toBe("failed");
    await expect(
      store.get("C123", "1720000000.000100"),
    ).resolves.toMatchObject({
      pendingReviewState: "pending",
    });
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

async function seedPendingReview(store: ThreadStore): Promise<void> {
  await store.put({
    channelId: "C123",
    threadTs: "1720000000.000100",
    magentaSessionId: "session-1",
    pendingExecutionId: "execution-2",
    pendingInterruptId: "interrupt-1",
    pendingResumeSchema: { type: "object" },
    pendingActionRequests: [
      { name: "mongodb__insert_many", args: { count: 1 } },
      { name: "mongodb__create_index", args: { name: "sku_1" } },
    ],
    pendingRequestedBySlackUserId: "U123",
    updatedAt: new Date(),
  });
}
