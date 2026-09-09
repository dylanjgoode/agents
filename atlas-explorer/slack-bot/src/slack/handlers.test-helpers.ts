import type { KnownBlock } from "@slack/types";

import type {
  InvocationProgress,
  InvocationProgressHandler,
  InvocationResult,
  InvokeInput,
  ResumeInput,
} from "../magenta/types.js";
import type { ThreadStore } from "../store/threadStore.js";
import type {
  AgentGateway,
  SlackPublisher,
} from "./handleUserMessage.js";

export class FakeAgentGateway implements AgentGateway {
  invokeInputs: InvokeInput[] = [];
  invokeStreamInputs: InvokeInput[] = [];
  resumeInputs: ResumeInput[] = [];
  resumeStreamInputs: ResumeInput[] = [];
  progressEvents: InvocationProgress[] = [];
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

  async invokeStream(
    input: InvokeInput,
    onProgress?: InvocationProgressHandler,
  ): Promise<InvocationResult> {
    this.invokeInputs.push(input);
    this.invokeStreamInputs.push(input);
    for (const progress of this.progressEvents) {
      await onProgress?.(progress);
    }
    return this.invokeResult;
  }

  async resumeStream(
    input: ResumeInput,
    onProgress?: InvocationProgressHandler,
  ): Promise<InvocationResult> {
    this.resumeInputs.push(input);
    this.resumeStreamInputs.push(input);
    for (const progress of this.progressEvents) {
      await onProgress?.(progress);
    }
    if (this.resumeError) {
      throw this.resumeError;
    }
    return this.resumeResult;
  }
}

export class FakePublisher implements SlackPublisher {
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

export const completed: Extract<
  InvocationResult,
  { kind: "completed" }
> = {
  kind: "completed",
  response: "There are three projects.",
  sessionId: "session-1",
  executionId: "execution-1",
};

export const suspended: Extract<
  InvocationResult,
  { kind: "suspended" }
> = {
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

export async function seedPendingReview(
  store: ThreadStore,
): Promise<void> {
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
