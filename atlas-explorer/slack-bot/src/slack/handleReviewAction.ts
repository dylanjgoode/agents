import { AgenticApiError } from "../magenta/client.js";
import type { ThreadStore } from "../store/threadStore.js";
import {
  createProgressHandler,
  publishInvocationResult,
  type AgentGateway,
  type HandlerLogger,
  type SlackPublisher,
} from "./handleUserMessage.js";

export type ReviewOutcome =
  | "completed"
  | "suspended"
  | "missing"
  | "unauthorized"
  | "uncertain"
  | "failed";

interface ReviewInput {
  channelId: string;
  threadTs: string;
  interruptId: string;
  slackUserId: string;
  decision: "approve" | "reject";
}

interface ReviewDependencies {
  agent: AgentGateway;
  publisher: SlackPublisher;
  store: ThreadStore;
  authorizedSlackUserIds?: ReadonlySet<string>;
  logger?: HandlerLogger;
  now?: () => Date;
}

export async function handleReviewDecision(
  input: ReviewInput,
  dependencies: ReviewDependencies,
): Promise<ReviewOutcome> {
  if (
    dependencies.authorizedSlackUserIds &&
    !dependencies.authorizedSlackUserIds.has(input.slackUserId)
  ) {
    await dependencies.publisher.postMessage({
      text: "You are not authorized to use this Atlas Explorer bot.",
    });
    return "unauthorized";
  }
  const record = await dependencies.store.get(
    input.channelId,
    input.threadTs,
  );
  if (
    !record?.pendingInterruptId ||
    !record.magentaSessionId ||
    record.pendingInterruptId !== input.interruptId
  ) {
    await dependencies.publisher.postMessage({
      text: "That review is no longer pending or has been replaced by a newer request.",
    });
    return "missing";
  }
  const sessionId = record.magentaSessionId;

  if (
    record.pendingRequestedBySlackUserId &&
    record.pendingRequestedBySlackUserId !== input.slackUserId
  ) {
    await dependencies.publisher.postMessage({
      text: "Only the requester can approve or reject this operation.",
    });
    return "unauthorized";
  }

  const claimed = await dependencies.store.claimPendingReview(
    input.channelId,
    input.threadTs,
    input.interruptId,
    dependencies.now?.() ?? new Date(),
  );
  if (!claimed) {
    await dependencies.publisher.postMessage({
      text: "That review is already being handled or is no longer pending.",
    });
    return "missing";
  }

  const interrupts = claimed.pendingInterrupts?.length
    ? claimed.pendingInterrupts
    : [
        {
          id: input.interruptId,
          actionRequests: claimed.pendingActionRequests ?? [],
        },
      ];
  const interruptDecisions = interrupts.map((interrupt) => ({
    interruptId: interrupt.id,
    decision: buildDecisions(
      Math.max(interrupt.actionRequests.length, 1),
      input.decision,
    ),
  }));
  const [primaryDecision, ...additionalInterrupts] = interruptDecisions;
  if (!primaryDecision) {
    return "missing";
  }

  await dependencies.publisher
    .setStatus(
      input.decision === "approve"
        ? "Applying approved operation…"
        : "Recording rejection…",
    )
    .catch((error: unknown) => {
      dependencies.logger?.warn?.("Could not set Slack status", error);
    });

  let result;
  try {
    result = await dependencies.agent.resumeStream(
      {
        sessionId,
        ...primaryDecision,
        ...(additionalInterrupts.length ? { additionalInterrupts } : {}),
        slackUserId: input.slackUserId,
      },
      createProgressHandler(
        dependencies.publisher,
        dependencies.logger,
      ),
    );
  } catch (error) {
    dependencies.logger?.error("Atlas Explorer review resume failed", error);
    const outcomeWasConfirmedNotApplied =
      error instanceof AgenticApiError &&
      (error.code === "RESUME_INPUT_INVALID" ||
        [400, 401, 403, 404, 422].includes(error.status));
    const { pendingReviewClaimedAt: _claimedAt, ...reviewRecord } = claimed;
    const stored = await dependencies.store.replaceClaimedReview(
      input.interruptId,
      {
      ...reviewRecord,
      pendingReviewState: outcomeWasConfirmedNotApplied
        ? "pending"
        : "uncertain",
      updatedAt: dependencies.now?.() ?? new Date(),
      },
    );
    if (!stored) {
      return "missing";
    }
    if (!outcomeWasConfirmedNotApplied) {
      await dependencies.publisher
        .updateReviewStatus?.("uncertain")
        .catch(() => undefined);
      await dependencies.publisher.postMessage({
        text: "The decision was sent, but Atlas Explorer could not confirm whether it completed. Check Atlas before retrying, then start a new Slack conversation.",
      });
      return "uncertain";
    }
    await dependencies.publisher.postMessage({
      text: "Atlas Explorer could not apply that decision. The review is still pending; please try again.",
    });
    return "failed";
  }

  try {
    const published = await publishInvocationResult(
      input,
      result,
      dependencies,
      { kind: "review", interruptId: input.interruptId },
    );
    if (!published) {
      return "missing";
    }
  } catch (error) {
    dependencies.logger?.error(
      "The review was applied but its Slack result could not be published",
      error,
    );
    await dependencies.publisher
      .postMessage({
        text: "The decision was applied, but Slack could not display the result. Send a follow-up in this thread to continue.",
      })
      .catch(() => undefined);
  }

  try {
    await dependencies.publisher.updateReviewStatus?.(
      input.decision === "approve" ? "approved" : "rejected",
    );
  } catch (error) {
    dependencies.logger?.warn?.(
      "Could not update the original Slack review message",
      error,
    );
  }

  return result.kind;
}

function buildDecisions(
  actionCount: number,
  decision: "approve" | "reject",
) {
  return Array.from({ length: actionCount }, () =>
    decision === "approve"
      ? ({ type: "approve" } as const)
      : ({
          type: "reject",
          message: "The Slack user rejected this operation.",
        } as const),
  );
}
