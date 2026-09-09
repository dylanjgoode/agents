import type {
  AgentActionRequest,
  AgentInterrupt,
} from "../magenta/types.js";

export interface ThreadRecord {
  channelId: string;
  threadTs: string;
  magentaSessionId?: string;
  recentSlackEventIds?: string[];
  inFlightEventId?: string;
  inFlightStartedAt?: Date;
  pendingExecutionId?: string;
  pendingInterruptId?: string;
  pendingInterrupts?: AgentInterrupt[];
  pendingResumeSchema?: Record<string, unknown>;
  pendingActionRequests?: AgentActionRequest[];
  pendingRequestedBySlackUserId?: string;
  pendingReviewState?: "pending" | "resuming" | "uncertain";
  pendingReviewClaimedAt?: Date;
  pendingDelivery?: PendingSlackDelivery;
  retentionState?: "inactive" | "delivery_pending";
  updatedAt: Date;
}

export interface PendingSlackDelivery {
  id: string;
  text: string;
  state?: "pending" | "sending";
  attemptCount?: number;
  claimId?: string;
  claimedAt?: Date;
}

export type TurnClaimStatus =
  | "claimed"
  | "duplicate"
  | "busy"
  | "pending_review";

export interface TurnClaim {
  status: TurnClaimStatus;
  record: ThreadRecord;
}

export interface ThreadStore {
  get(channelId: string, threadTs: string): Promise<ThreadRecord | null>;
  put(record: ThreadRecord): Promise<void>;
  claimTurn(
    channelId: string,
    threadTs: string,
    eventId: string,
    claimedAt: Date,
  ): Promise<TurnClaim>;
  replaceClaimedTurn(
    eventId: string,
    record: ThreadRecord,
  ): Promise<boolean>;
  claimPendingReview(
    channelId: string,
    threadTs: string,
    interruptId: string,
    claimedAt: Date,
  ): Promise<ThreadRecord | null>;
  replaceClaimedReview(
    interruptId: string,
    record: ThreadRecord,
  ): Promise<boolean>;
  claimPendingDelivery(
    channelId: string,
    threadTs: string,
    deliveryId: string,
    claimId: string,
    claimedAt: Date,
  ): Promise<PendingSlackDelivery | null>;
  clearPendingDelivery(
    channelId: string,
    threadTs: string,
    deliveryId: string,
    claimId: string,
  ): Promise<boolean>;
  close(): Promise<void>;
}

export function threadKey(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}
