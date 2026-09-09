import { beforeEach, describe, expect, it } from "vitest";

import { AgenticApiError } from "../magenta/client.js";
import { MemoryThreadStore } from "../store/memoryThreadStore.js";
import type { ThreadStore } from "../store/threadStore.js";
import { handleReviewDecision } from "./handleReviewAction.js";
import { handleUserMessage } from "./handleUserMessage.js";
import {
  completed,
  FakeAgentGateway,
  FakePublisher,
  seedPendingReview,
} from "./handlers.test-helpers.js";

describe("handleReviewDecision", () => {
  let agent: FakeAgentGateway;
  let publisher: FakePublisher;
  let store: ThreadStore;

  beforeEach(() => {
    agent = new FakeAgentGateway();
    publisher = new FakePublisher();
    store = new MemoryThreadStore();
  });

  it("approves every action and clears pending review state", async () => {
    await seedPendingReview(store);
    agent.resumeResult = {
      ...completed,
      response: "The item was inserted.",
      executionId: "execution-3",
    };
    agent.progressEvents = [
      {
        content: "Calling tool: mongodb__insert_many...",
        phase: "tool_start",
        toolName: "mongodb__insert_many",
      },
    ];

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
    expect(publisher.statuses).toEqual([
      "Applying approved operation…",
      "Calling tool: mongodb__insert_many...",
    ]);
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
});
