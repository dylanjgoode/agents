import { randomUUID } from "node:crypto";

import type { KnownBlock } from "@slack/types";

import type {
  InvocationProgressHandler,
  InvocationResult,
  InvokeInput,
  ResumeInput,
} from "../magenta/types.js";
import type { ThreadRecord, ThreadStore } from "../store/threadStore.js";
import { buildReviewMessage } from "./blocks.js";

const MAX_SLACK_TEXT_LENGTH = 38_000;
const REVIEW_CLAIM_MAX_MS = 10 * 60 * 1_000;

export interface AgentGateway {
  invoke(input: InvokeInput): Promise<InvocationResult>;
  invokeStream(
    input: InvokeInput,
    onProgress?: InvocationProgressHandler,
  ): Promise<InvocationResult>;
  resume(input: ResumeInput): Promise<InvocationResult>;
  resumeStream(
    input: ResumeInput,
    onProgress?: InvocationProgressHandler,
  ): Promise<InvocationResult>;
}

export interface SlackPublisher {
  setStatus(status: string): Promise<void>;
  postMessage(message: { text: string; blocks?: KnownBlock[] }): Promise<void>;
  postAgentResponse(text: string, deliveryId: string): Promise<void>;
  hasAgentResponse(deliveryId: string): Promise<boolean>;
  updateReviewStatus?(
    status: "approved" | "rejected" | "uncertain",
  ): Promise<void>;
}

export interface HandlerLogger {
  error(message: string, error: unknown): void;
  warn?(message: string, error: unknown): void;
}

export interface UserMessageInput {
  channelId: string;
  threadTs: string;
  eventId?: string;
  slackUserId: string;
  text: string;
}

interface HandlerDependencies {
  agent: AgentGateway;
  publisher: SlackPublisher;
  store: ThreadStore;
  authorizedSlackUserIds?: ReadonlySet<string>;
  logger?: HandlerLogger;
  now?: () => Date;
}

export type InvocationClaim =
  | { kind: "turn"; eventId: string }
  | { kind: "review"; interruptId: string };

export async function handleUserMessage(
  input: UserMessageInput,
  dependencies: HandlerDependencies,
): Promise<void> {
  if (
    dependencies.authorizedSlackUserIds &&
    !dependencies.authorizedSlackUserIds.has(input.slackUserId)
  ) {
    await dependencies.publisher.postMessage({
      text: "You are not authorized to use this Atlas Explorer bot.",
    });
    return;
  }
  const message = input.text.trim();
  if (!message) {
    await dependencies.publisher.postMessage({
      text: "Ask me about your MongoDB databases or Atlas resources.",
    });
    return;
  }

  const claimedAt = dependencies.now?.() ?? new Date();
  const eventId = input.eventId ?? randomUUID();
  const claim = await dependencies.store.claimTurn(
    input.channelId,
    input.threadTs,
    eventId,
    claimedAt,
  );
  if (claim.status === "duplicate") {
    await deliverPendingResponse(claim.record, dependencies);
    return;
  }
  if (claim.status === "busy") {
    await dependencies.publisher.postMessage({
      text: "Atlas Explorer is already working on another message in this thread. After it responds, send your message again.",
    });
    return;
  }
  if (claim.status === "pending_review") {
    if (claim.record.pendingReviewState === "uncertain") {
      await dependencies.publisher.postMessage({
        text: "The previous mutation decision has an uncertain outcome. Check Atlas before retrying, then start a new Slack conversation.",
      });
      return;
    }
    if (claim.record.pendingReviewState === "resuming") {
      const reviewClaimExpired =
        !claim.record.pendingReviewClaimedAt ||
        claimedAt.getTime() -
          claim.record.pendingReviewClaimedAt.getTime() >=
          REVIEW_CLAIM_MAX_MS;
      if (reviewClaimExpired && claim.record.pendingInterruptId) {
        const {
          pendingReviewClaimedAt: _reviewClaimedAt,
          ...uncertainRecord
        } = claim.record;
        const stored = await dependencies.store.replaceClaimedReview(
          claim.record.pendingInterruptId,
          {
            ...uncertainRecord,
            pendingReviewState: "uncertain",
            updatedAt: claimedAt,
          },
        );
        if (stored) {
          await dependencies.publisher.postMessage({
            text: "Atlas Explorer could not confirm whether the earlier mutation decision completed. Check Atlas before retrying, then start a new Slack conversation.",
          });
        }
        return;
      }
      await dependencies.publisher.postMessage({
        text: "The mutation decision is being processed. Wait for Atlas Explorer to finish before sending another message.",
      });
      return;
    }
    await dependencies.publisher.postMessage(
      claim.record.pendingActionRequests?.length &&
        claim.record.pendingInterruptId
        ? buildReviewMessage(claim.record.pendingActionRequests, {
            channelId: input.channelId,
            threadTs: input.threadTs,
            interruptId: claim.record.pendingInterruptId,
          })
        : {
            text: "This thread is waiting for a mutation decision. Use the existing approval buttons before sending another message.",
          },
    );
    return;
  }

  let activeRecord = claim.record;
  if (activeRecord.pendingDelivery) {
    const deliveryOutcome = await deliverPendingResponse(
      activeRecord,
      dependencies,
    );
    if (deliveryOutcome !== "delivered") {
      await releaseTurn(eventId, activeRecord, dependencies).catch(
        (error: unknown) => {
          dependencies.logger?.error(
            "Could not release a turn after Slack delivery failed",
            error,
          );
        },
      );
      return;
    }
    const { pendingDelivery: _delivery, ...withoutDelivery } = activeRecord;
    activeRecord = withoutDelivery;
  }

  await dependencies.publisher
    .setStatus("Exploring Atlas…")
    .catch((error: unknown) => {
      dependencies.logger?.warn?.("Could not set Slack status", error);
    });

  let result: InvocationResult;
  try {
    result = await dependencies.agent.invokeStream(
      {
        message,
        ...(activeRecord.magentaSessionId
          ? { sessionId: activeRecord.magentaSessionId }
          : {}),
        slackUserId: input.slackUserId,
      },
      createProgressHandler(
        dependencies.publisher,
        dependencies.logger,
      ),
    );
  } catch (error) {
    dependencies.logger?.error("Atlas Explorer invocation failed", error);
    const released = await releaseTurn(eventId, activeRecord, dependencies).catch(
      (storeError: unknown) => {
        dependencies.logger?.error(
          "Could not release failed Slack thread turn",
          storeError,
        );
        return false;
      },
    );
    if (released) {
      await dependencies.publisher.postMessage({
        text: "Atlas Explorer could not complete that request. Please try again in a moment.",
      });
    }
    return;
  }

  try {
    await publishInvocationResult(input, result, dependencies, {
      kind: "turn",
      eventId,
    });
  } catch (error) {
    dependencies.logger?.error(
      "Atlas Explorer result could not be published",
      error,
    );
    await dependencies.publisher
      .postMessage({
        text: "Atlas Explorer completed the request, but Slack could not display the result. Send a follow-up in this thread to continue.",
      })
      .catch(() => undefined);
  }
}

export function createProgressHandler(
  publisher: SlackPublisher,
  logger?: HandlerLogger,
): InvocationProgressHandler {
  return async (progress) => {
    const status = progress.content.trim();
    if (!status) {
      return;
    }
    await publisher.setStatus(status.slice(0, 100)).catch(
      (error: unknown) => {
        logger?.warn?.(
          "Could not update Slack progress status",
          error,
        );
      },
    );
  };
}

export async function publishInvocationResult(
  input: Pick<
    UserMessageInput,
    "channelId" | "threadTs" | "slackUserId"
  >,
  result: InvocationResult,
  dependencies: HandlerDependencies,
  claim: InvocationClaim,
): Promise<boolean> {
  const updatedAt = dependencies.now?.() ?? new Date();
  const current = await dependencies.store.get(
    input.channelId,
    input.threadTs,
  );
  const continuity = current?.recentSlackEventIds
    ? { recentSlackEventIds: current.recentSlackEventIds }
    : {};
  if (result.kind === "completed") {
    const responseText = truncateAgentResponse(result.response);
    const deliveryId =
      claim.kind === "turn"
        ? claim.eventId
        : `review:${claim.interruptId}`;
    const record: ThreadRecord = {
      channelId: input.channelId,
      threadTs: input.threadTs,
      magentaSessionId: result.sessionId,
      pendingDelivery: {
        id: deliveryId,
        text: responseText,
        state: "pending",
        attemptCount: 0,
      },
      retentionState: "delivery_pending",
      ...continuity,
      updatedAt,
    };
    const stored = await replaceClaimedRecord(record, claim, dependencies.store);
    if (!stored) {
      dependencies.logger?.warn?.(
        "Discarded a result from a stale Slack thread claim",
        claim,
      );
      return false;
    }
    const deliveryOutcome = await deliverPendingResponse(record, dependencies);
    if (deliveryOutcome === "failed") {
      throw new Error("Slack response delivery failed");
    }
    return true;
  }

  const interrupt = result.interrupts[0];
  if (!interrupt) {
    throw new Error("Suspended invocation did not include an interrupt");
  }
  const actionRequests = result.interrupts.flatMap(
    (pendingInterrupt) => pendingInterrupt.actionRequests,
  );
  const record: ThreadRecord = {
    channelId: input.channelId,
    threadTs: input.threadTs,
    magentaSessionId: result.sessionId,
    pendingExecutionId: result.executionId,
    pendingInterruptId: interrupt.id,
    pendingInterrupts: result.interrupts,
    pendingActionRequests: actionRequests,
    pendingRequestedBySlackUserId: input.slackUserId,
    pendingReviewState: "pending",
    ...continuity,
    ...(result.resumeSchema
      ? { pendingResumeSchema: result.resumeSchema }
      : {}),
    updatedAt,
  };
  const stored = await replaceClaimedRecord(record, claim, dependencies.store);
  if (!stored) {
    dependencies.logger?.warn?.(
      "Discarded a suspension from a stale Slack thread claim",
      claim,
    );
    return false;
  }
  await dependencies.publisher.postMessage(
    buildReviewMessage(actionRequests, {
      channelId: input.channelId,
      threadTs: input.threadTs,
      interruptId: interrupt.id,
    }),
  );
  return true;
}

async function releaseTurn(
  eventId: string,
  record: ThreadRecord,
  dependencies: HandlerDependencies,
): Promise<boolean> {
  const {
    inFlightEventId: _eventId,
    inFlightStartedAt: _startedAt,
    ...released
  } = record;
  return dependencies.store.replaceClaimedTurn(eventId, {
    ...released,
    ...(released.pendingDelivery
      ? { retentionState: "delivery_pending" as const }
      : { retentionState: "inactive" as const }),
    updatedAt: dependencies.now?.() ?? new Date(),
  });
}

function replaceClaimedRecord(
  record: ThreadRecord,
  claim: InvocationClaim,
  store: ThreadStore,
): Promise<boolean> {
  return claim.kind === "turn"
    ? store.replaceClaimedTurn(claim.eventId, record)
    : store.replaceClaimedReview(claim.interruptId, record);
}

async function deliverPendingResponse(
  record: ThreadRecord,
  dependencies: HandlerDependencies,
): Promise<"delivered" | "busy" | "failed"> {
  const delivery = record.pendingDelivery;
  if (!delivery) {
    return "delivered";
  }
  const claimId = randomUUID();
  const claimed = await dependencies.store.claimPendingDelivery(
    record.channelId,
    record.threadTs,
    delivery.id,
    claimId,
    dependencies.now?.() ?? new Date(),
  );
  if (!claimed) {
    return "busy";
  }
  try {
    const alreadyDelivered =
      (claimed.attemptCount ?? 1) > 1 &&
      (await dependencies.publisher.hasAgentResponse(delivery.id));
    if (!alreadyDelivered) {
      await dependencies.publisher.postAgentResponse(
        delivery.text,
        delivery.id,
      );
    }
    await dependencies.store.clearPendingDelivery(
      record.channelId,
      record.threadTs,
      delivery.id,
      claimId,
    );
    return "delivered";
  } catch (error) {
    dependencies.logger?.error(
      "Could not deliver a stored Slack response",
      error,
    );
    return "failed";
  }
}

export function truncateAgentResponse(text: string): string {
  if (text.length <= MAX_SLACK_TEXT_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_SLACK_TEXT_LENGTH - 43)}\n\n_[Response truncated for Slack.]_`;
}
