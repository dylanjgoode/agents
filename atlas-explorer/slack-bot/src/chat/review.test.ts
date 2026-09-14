import { beforeEach, describe, expect, it } from "vitest";

import { AgenticApiError } from "../magenta/client.js";
import { MemoryThreadStore } from "../store/memoryThreadStore.js";
import type { ThreadStore } from "../store/threadStore.js";
import {
  completed,
  callingTool,
  FakeAgentGateway,
  FakeConversation,
  seedPendingReview,
} from "./handlers.test-helpers.js";
import { handleReviewDecision } from "./review.js";

const THREAD_ID = "slack:C123:1720000000.000100";
const ACTOR_ID = "slack:U123";

describe("handleReviewDecision", () => {
  let agent: FakeAgentGateway;
  let conversation: FakeConversation;
  let store: ThreadStore;

  beforeEach(() => {
    agent = new FakeAgentGateway();
    conversation = new FakeConversation();
    store = new MemoryThreadStore();
  });

  it("resumes every action and pending interrupt exactly once", async () => {
    await store.put({
      threadId: THREAD_ID,
      magentaSessionId: "session-1",
      pendingInterruptId: "interrupt-1",
      pendingInterrupts: [
        {
          id: "interrupt-1",
          actionRequests: [
            { name: "insert", args: {} },
            { name: "update", args: {} },
          ],
        },
        {
          id: "interrupt-2",
          actionRequests: [{ name: "createIndex", args: {} }],
        },
      ],
      pendingRequestedByActorId: ACTOR_ID,
      pendingReviewState: "pending",
      updatedAt: new Date(),
    });
    agent.resumeResult = completed;
    const decision = {
      threadId: THREAD_ID,
      interruptId: "interrupt-1",
      actorId: ACTOR_ID,
      decision: "approve" as const,
    };

    const outcomes = await Promise.all([
      handleReviewDecision(decision, {
        agent,
        conversation,
        store,
      }),
      handleReviewDecision(decision, {
        agent,
        conversation,
        store,
      }),
    ]);

    expect(agent.resumeInputs).toEqual([
      {
        sessionId: "session-1",
        actorId: ACTOR_ID,
        interruptId: "interrupt-1",
        decision: [{ type: "approve" }, { type: "approve" }],
        additionalInterrupts: [
          {
            interruptId: "interrupt-2",
            decision: [{ type: "approve" }],
          },
        ],
      },
    ]);
    expect(outcomes).toContain("completed");
    expect(outcomes).toContain("missing");
  });

  it("restricts decisions to the original platform-qualified actor", async () => {
    await seedPendingReview(store);

    const outcome = await handleReviewDecision(
      {
        threadId: THREAD_ID,
        interruptId: "interrupt-1",
        actorId: "slack:U999",
        decision: "approve",
      },
      { agent, conversation, store },
    );

    expect(outcome).toBe("unauthorized");
    expect(agent.resumeInputs).toEqual([]);
    expect(conversation.messages[0]).toMatch(/only the requester/i);
  });

  it("rejects stale action values and preserves the newer interrupt", async () => {
    await seedPendingReview(store);

    const outcome = await handleReviewDecision(
      {
        threadId: THREAD_ID,
        interruptId: "interrupt-old",
        actorId: ACTOR_ID,
        decision: "reject",
      },
      { agent, conversation, store },
    );

    expect(outcome).toBe("missing");
    expect(agent.resumeInputs).toEqual([]);
    expect(await store.get(THREAD_ID)).toMatchObject({
      pendingInterruptId: "interrupt-1",
    });
  });

  it("marks ambiguous resume outcomes uncertain and edits the review", async () => {
    await seedPendingReview(store);
    agent.resumeError = new AgenticApiError(
      "response lost",
      {
        status: 0,
        code: "REQUEST_FAILED",
        requestOutcome: "unknown",
      },
    );

    const outcome = await handleReviewDecision(
      {
        threadId: THREAD_ID,
        interruptId: "interrupt-1",
        actorId: ACTOR_ID,
        decision: "approve",
      },
      { agent, conversation, store },
    );

    expect(outcome).toBe("uncertain");
    expect(await store.get(THREAD_ID)).toMatchObject({
      pendingReviewState: "uncertain",
    });
    expect(conversation.reviewStatuses).toEqual(["uncertain"]);
  });

  it("shows a leading directory listing when resuming an existing session", async () => {
    await seedPendingReview(store);
    agent.resumeResult = completed;
    agent.progressEvents = [
      callingTool("filesystem_ls"),
      callingTool("mongodb__insert_many"),
    ];

    await handleReviewDecision(
      {
        threadId: THREAD_ID,
        interruptId: "interrupt-1",
        actorId: ACTOR_ID,
        decision: "approve",
      },
      { agent, conversation, store },
    );

    expect(conversation.statuses).toEqual([
      "Applying approved operation…",
      "Calling tool: filesystem_ls...",
      "Calling tool: mongodb__insert_many...",
    ]);
  });

  it("keeps a review pending when authentication fails before dispatch", async () => {
    await seedPendingReview(store);
    agent.resumeError = new AgenticApiError(
      "token endpoint unavailable",
      {
        status: 0,
        code: "AUTHENTICATION_FAILED",
        requestOutcome: "not_sent",
      },
    );

    const outcome = await handleReviewDecision(
      {
        threadId: THREAD_ID,
        interruptId: "interrupt-1",
        actorId: ACTOR_ID,
        decision: "approve",
      },
      { agent, conversation, store },
    );

    expect(outcome).toBe("failed");
    expect(await store.get(THREAD_ID)).toMatchObject({
      pendingReviewState: "pending",
    });
    expect(conversation.messages).toContain(
      "Atlas Explorer could not apply that decision. The review is still pending; please try again.",
    );
  });

  it("keeps a confirmed-invalid resume pending for another attempt", async () => {
    await seedPendingReview(store);
    agent.resumeError = new AgenticApiError(
      "invalid resume map",
      {
        status: 409,
        code: "RESUME_INPUT_INVALID",
        requestOutcome: "rejected",
      },
    );

    const outcome = await handleReviewDecision(
      {
        threadId: THREAD_ID,
        interruptId: "interrupt-1",
        actorId: ACTOR_ID,
        decision: "reject",
      },
      { agent, conversation, store },
    );

    expect(outcome).toBe("failed");
    expect(await store.get(THREAD_ID)).toMatchObject({
      pendingReviewState: "pending",
    });
  });
});
