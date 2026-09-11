import { beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryThreadStore } from "../store/memoryThreadStore.js";
import type { ThreadStore } from "../store/threadStore.js";
import {
  handleConversationMessage,
  recoverPendingDelivery,
} from "./conversation.js";
import {
  completed,
  FakeAgentGateway,
  FakeConversation,
  suspended,
} from "./handlers.test-helpers.js";

const THREAD_ID = "slack:C123:1720000000.000100";
const ACTOR_ID = "slack:U123";

describe("handleConversationMessage", () => {
  let agent: FakeAgentGateway;
  let conversation: FakeConversation;
  let store: ThreadStore;

  beforeEach(() => {
    agent = new FakeAgentGateway();
    conversation = new FakeConversation();
    store = new MemoryThreadStore();
  });

  it("starts a session with a platform-qualified actor and reuses it", async () => {
    agent.invokeResult = completed;
    await handleConversationMessage(
      {
        threadId: THREAD_ID,
        eventId: "event-1",
        actorId: ACTOR_ID,
        text: "List projects",
      },
      { agent, conversation, store },
    );

    agent.invokeResult = {
      ...completed,
      response: "The first project has two clusters.",
    };
    await handleConversationMessage(
      {
        threadId: THREAD_ID,
        eventId: "event-2",
        actorId: ACTOR_ID,
        text: "What about the first?",
      },
      { agent, conversation, store },
    );

    expect(agent.invokeInputs).toEqual([
      {
        message: "List projects",
        actorId: ACTOR_ID,
      },
      {
        message: "What about the first?",
        actorId: ACTOR_ID,
        sessionId: "session-1",
      },
    ]);
    expect(await store.get(THREAD_ID)).toMatchObject({
      magentaSessionId: "session-1",
    });
  });

  it("enforces a platform-neutral allowlist", async () => {
    agent.invokeResult = completed;

    await handleConversationMessage(
      {
        threadId: THREAD_ID,
        eventId: "event-1",
        actorId: ACTOR_ID,
        text: "List projects",
      },
      {
        agent,
        conversation,
        store,
        authorizedActorIds: new Set(["discord:U123"]),
      },
    );

    expect(agent.invokeInputs).toEqual([]);
    expect(conversation.messages[0]).toMatch(/not authorized/i);
  });

  it("stores every interrupt and posts a cross-platform review card", async () => {
    agent.invokeResult = suspended;

    await handleConversationMessage(
      {
        threadId: THREAD_ID,
        eventId: "event-1",
        actorId: ACTOR_ID,
        text: "Insert an item",
      },
      { agent, conversation, store },
    );

    expect(await store.get(THREAD_ID)).toMatchObject({
      pendingInterruptId: "interrupt-1",
      pendingInterrupts: suspended.interrupts,
      pendingRequestedByActorId: ACTOR_ID,
    });
    expect(conversation.messages[0]).toMatchObject({
      card: expect.objectContaining({ type: "card" }),
      fallbackText: expect.stringMatching(/requires approval/i),
    });
  });

  it("keeps durable turn claims authoritative under concurrent handlers", async () => {
    agent.invokeResult = completed;
    let release!: () => void;
    conversation.deliveryGate = new Promise((resolve) => {
      release = resolve;
    });

    const first = handleConversationMessage(
      {
        threadId: THREAD_ID,
        eventId: "event-1",
        actorId: ACTOR_ID,
        text: "List projects",
      },
      { agent, conversation, store },
    );
    await vi.waitFor(() => expect(agent.invokeInputs).toHaveLength(1));

    await handleConversationMessage(
      {
        threadId: THREAD_ID,
        eventId: "event-2",
        actorId: ACTOR_ID,
        text: "Another request",
      },
      { agent, conversation, store },
    );

    expect(agent.invokeInputs).toHaveLength(1);
    expect(conversation.messages).toContainEqual(
      expect.stringMatching(/already/i),
    );
    release();
    await first;
  });

  it("recovers a pending delivery during later thread activity", async () => {
    agent.invokeResult = completed;
    conversation.deliveryError = new Error("delivery failed");
    let now = new Date("2026-09-09T12:00:00.000Z");
    store = new MemoryThreadStore({
      now: () => now.getTime(),
    });
    const original = {
      threadId: THREAD_ID,
      eventId: "event-1",
      actorId: ACTOR_ID,
      text: "List projects",
    };

    await handleConversationMessage(original, {
      agent,
      conversation,
      store,
      now: () => now,
    });
    conversation.deliveryError = undefined;
    now = new Date("2026-09-09T12:06:00.000Z");
    agent.invokeResult = {
      ...completed,
      response: "I am here.",
    };

    await handleConversationMessage(
      {
        ...original,
        eventId: "event-2",
        text: "Are you there?",
      },
      { agent, conversation, store, now: () => now },
    );

    expect(conversation.agentResponses).toEqual([
      completed.response,
      "I am here.",
    ]);
    expect(agent.invokeInputs).toHaveLength(2);
    expect(await store.get(THREAD_ID)).not.toHaveProperty(
      "pendingDelivery",
    );
  });

  it("reconciles a response accepted before an ambiguous delivery error", async () => {
    agent.invokeResult = completed;
    conversation.deliveryError = new Error("response lost");
    conversation.acceptDeliveryBeforeError = true;
    let now = new Date("2026-09-09T12:00:00.000Z");
    store = new MemoryThreadStore({
      now: () => now.getTime(),
    });
    const input = {
      threadId: THREAD_ID,
      eventId: "event-1",
      actorId: ACTOR_ID,
      text: "List projects",
    };

    await handleConversationMessage(input, {
      agent,
      conversation,
      store,
      now: () => now,
    });
    conversation.deliveryError = undefined;
    now = new Date("2026-09-09T12:06:00.000Z");

    await recoverPendingDelivery(THREAD_ID, {
      agent,
      conversation,
      store,
      now: () => now,
    });

    expect(conversation.deliveryAttempts).toBe(1);
    expect(await store.get(THREAD_ID)).not.toHaveProperty(
      "pendingDelivery",
    );
  });

  it("does not risk a duplicate when a future adapter cannot reconcile delivery", async () => {
    await store.put({
      threadId: THREAD_ID,
      pendingDelivery: {
        id: "delivery-1",
        text: "Stored result",
        state: "pending",
        attemptCount: 1,
      },
      retentionState: "delivery_pending",
      updatedAt: new Date(),
    });
    conversation.unknownDeliveryStatus = true;

    await expect(
      recoverPendingDelivery(THREAD_ID, {
        agent,
        conversation,
        store,
      }),
    ).resolves.toBe("uncertain");

    expect(conversation.deliveryAttempts).toBe(0);
    expect(await store.get(THREAD_ID)).toHaveProperty(
      "pendingDelivery",
    );
  });
});
