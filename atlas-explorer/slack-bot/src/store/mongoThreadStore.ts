import { MongoClient } from "mongodb";

import type {
  ThreadRecord,
  ThreadStore,
  TurnClaim,
} from "./threadStore.js";
import { threadKey } from "./threadStore.js";

interface StoredThreadRecord extends ThreadRecord {
  _id: string;
}

export interface ThreadCollection {
  createIndex(
    keys: Record<string, 1 | -1>,
    options: {
      unique?: boolean;
      name?: string;
      expireAfterSeconds?: number;
      partialFilterExpression?: Record<string, unknown>;
    },
  ): Promise<string>;
  findOne(filter: { _id: string }): Promise<StoredThreadRecord | null>;
  replaceOne(
    filter: Record<string, unknown>,
    replacement: StoredThreadRecord,
    options: { upsert: boolean },
  ): Promise<{ matchedCount: number }>;
  insertOne(document: StoredThreadRecord): Promise<unknown>;
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: { returnDocument: "after" },
  ): Promise<StoredThreadRecord | null>;
}

interface MongoThreadStoreOptions {
  client?: MongoClient;
  initializeOnAccess?: boolean;
}

const TURN_LEASE_MS = 10 * 60 * 1_000;
const DELIVERY_LEASE_MS = 5 * 60 * 1_000;
const RECENT_EVENT_LIMIT = 20;

export class MongoThreadStore implements ThreadStore {
  private readonly collection: ThreadCollection;
  private readonly client?: MongoClient;
  private readonly initializeOnAccess: boolean;
  private initialization?: Promise<void>;

  constructor(
    collection: ThreadCollection,
    options: MongoThreadStoreOptions = {},
  ) {
    this.collection = collection;
    this.client = options.client;
    this.initializeOnAccess = options.initializeOnAccess ?? false;
  }

  static async connect(
    uri: string,
    databaseName: string,
  ): Promise<MongoThreadStore> {
    const client = new MongoClient(uri);
    try {
      await client.connect();
      const collection = client
        .db(databaseName)
        .collection<StoredThreadRecord>("slack_threads");
      const store = new MongoThreadStore(
        collection as unknown as ThreadCollection,
        { client },
      );
      await store.initialize();
      return store;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  static createLazy(uri: string, databaseName: string): MongoThreadStore {
    const client = new MongoClient(uri);
    const collection = client
      .db(databaseName)
      .collection<StoredThreadRecord>("slack_threads");
    return new MongoThreadStore(collection as unknown as ThreadCollection, {
      client,
      initializeOnAccess: true,
    });
  }

  async initialize(): Promise<void> {
    await this.collection.createIndex(
      { channelId: 1, threadTs: 1 },
      {
        name: "slack_thread_unique",
        unique: true,
      },
    );
    await this.collection.createIndex(
      { updatedAt: 1 },
      {
        name: "inactive_thread_ttl",
        expireAfterSeconds: 30 * 24 * 60 * 60,
        partialFilterExpression: {
          retentionState: "inactive",
        },
      },
    );
    await this.collection.createIndex(
      { updatedAt: 1 },
      {
        name: "pending_delivery_ttl",
        expireAfterSeconds: 24 * 60 * 60,
        partialFilterExpression: {
          retentionState: "delivery_pending",
        },
      },
    );
  }

  async get(
    channelId: string,
    threadTs: string,
  ): Promise<ThreadRecord | null> {
    await this.ensureInitialized();
    const document = await this.collection.findOne({
      _id: threadKey(channelId, threadTs),
    });
    if (!document) {
      return null;
    }
    const { _id: _discarded, ...record } = document;
    return record;
  }

  async put(record: ThreadRecord): Promise<void> {
    await this.ensureInitialized();
    const document: StoredThreadRecord = {
      _id: threadKey(record.channelId, record.threadTs),
      ...record,
    };
    await this.collection.replaceOne(
      { _id: document._id },
      document,
      { upsert: true },
    );
  }

  async claimTurn(
    channelId: string,
    threadTs: string,
    eventId: string,
    claimedAt: Date,
  ): Promise<TurnClaim> {
    await this.ensureInitialized();
    const key = threadKey(channelId, threadTs);
    const staleBefore = new Date(claimedAt.getTime() - TURN_LEASE_MS);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existing = await this.collection.findOne({ _id: key });
      if (!existing) {
        const inserted: StoredThreadRecord = {
          _id: key,
          channelId,
          threadTs,
          recentSlackEventIds: [eventId],
          inFlightEventId: eventId,
          inFlightStartedAt: claimedAt,
          updatedAt: claimedAt,
        };
        try {
          await this.collection.insertOne(inserted);
          const { _id: _discarded, ...record } = inserted;
          return { status: "claimed", record };
        } catch (error) {
          if (isDuplicateKeyError(error)) {
            continue;
          }
          throw error;
        }
      }

      const status = turnConflictStatus(existing, eventId, staleBefore);
      if (status) {
        const { _id: _discarded, ...record } = existing;
        return { status, record };
      }

      const updated = await this.collection.findOneAndUpdate(
        {
          _id: key,
          recentSlackEventIds: { $ne: eventId },
          $and: [
            {
              $or: [
                { pendingInterruptId: { $exists: false } },
                { pendingInterruptId: null },
              ],
            },
            {
              $or: [
                { inFlightEventId: { $exists: false } },
                { inFlightEventId: null },
                { inFlightStartedAt: { $lt: staleBefore } },
              ],
            },
          ],
        },
        {
          $set: {
            inFlightEventId: eventId,
            inFlightStartedAt: claimedAt,
            updatedAt: claimedAt,
          },
          $unset: { retentionState: "" },
          $push: {
            recentSlackEventIds: {
              $each: [eventId],
              $slice: -RECENT_EVENT_LIMIT,
            },
          },
        },
        { returnDocument: "after" },
      );
      if (updated) {
        const { _id: _discarded, ...record } = updated;
        return { status: "claimed", record };
      }
    }

    const current = await this.collection.findOne({ _id: key });
    if (!current) {
      throw new Error("Could not claim Slack thread turn");
    }
    const { _id: _discarded, ...record } = current;
    return {
      status:
        turnConflictStatus(current, eventId, staleBefore) ?? "busy",
      record,
    };
  }

  async replaceClaimedTurn(
    eventId: string,
    record: ThreadRecord,
  ): Promise<boolean> {
    await this.ensureInitialized();
    const result = await this.collection.replaceOne(
      {
        _id: threadKey(record.channelId, record.threadTs),
        inFlightEventId: eventId,
      },
      {
        _id: threadKey(record.channelId, record.threadTs),
        ...record,
      },
      { upsert: false },
    );
    return result.matchedCount === 1;
  }

  async claimPendingReview(
    channelId: string,
    threadTs: string,
    interruptId: string,
    claimedAt: Date,
  ): Promise<ThreadRecord | null> {
    await this.ensureInitialized();
    const document = await this.collection.findOneAndUpdate(
      {
        _id: threadKey(channelId, threadTs),
        pendingInterruptId: interruptId,
        pendingReviewState: { $in: [null, "pending"] },
      },
      {
        $set: {
          pendingReviewState: "resuming",
          pendingReviewClaimedAt: claimedAt,
          updatedAt: claimedAt,
        },
      },
      { returnDocument: "after" },
    );
    if (!document) {
      return null;
    }
    const { _id: _discarded, ...record } = document;
    return record;
  }

  async replaceClaimedReview(
    interruptId: string,
    record: ThreadRecord,
  ): Promise<boolean> {
    await this.ensureInitialized();
    const result = await this.collection.replaceOne(
      {
        _id: threadKey(record.channelId, record.threadTs),
        pendingInterruptId: interruptId,
        pendingReviewState: "resuming",
      },
      {
        _id: threadKey(record.channelId, record.threadTs),
        ...record,
      },
      { upsert: false },
    );
    return result.matchedCount === 1;
  }

  async clearPendingDelivery(
    channelId: string,
    threadTs: string,
    deliveryId: string,
    claimId: string,
  ): Promise<boolean> {
    await this.ensureInitialized();
    const document = await this.collection.findOneAndUpdate(
      {
        _id: threadKey(channelId, threadTs),
        "pendingDelivery.id": deliveryId,
        "pendingDelivery.claimId": claimId,
      },
      {
        $set: { retentionState: "inactive" },
        $unset: { pendingDelivery: "" },
      },
      { returnDocument: "after" },
    );
    return document !== null;
  }

  async claimPendingDelivery(
    channelId: string,
    threadTs: string,
    deliveryId: string,
    claimId: string,
    claimedAt: Date,
  ) {
    await this.ensureInitialized();
    const staleBefore = new Date(
      claimedAt.getTime() - DELIVERY_LEASE_MS,
    );
    const document = await this.collection.findOneAndUpdate(
      {
        _id: threadKey(channelId, threadTs),
        "pendingDelivery.id": deliveryId,
        $or: [
          { "pendingDelivery.state": { $in: [null, "pending"] } },
          {
            "pendingDelivery.state": "sending",
            "pendingDelivery.claimedAt": { $lt: staleBefore },
          },
        ],
      },
      {
        $inc: { "pendingDelivery.attemptCount": 1 },
        $set: {
          "pendingDelivery.state": "sending",
          "pendingDelivery.claimId": claimId,
          "pendingDelivery.claimedAt": claimedAt,
        },
      },
      { returnDocument: "after" },
    );
    return document?.pendingDelivery ?? null;
  }

  async close(): Promise<void> {
    await this.client?.close();
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initializeOnAccess) {
      return;
    }
    this.initialization ??= this.initialize();
    await this.initialization;
  }
}

function turnConflictStatus(
  record: StoredThreadRecord,
  eventId: string,
  staleBefore: Date,
): Exclude<TurnClaim["status"], "claimed"> | null {
  if (record.recentSlackEventIds?.includes(eventId)) {
    return "duplicate";
  }
  if (record.pendingInterruptId) {
    return "pending_review";
  }
  if (
    record.inFlightEventId &&
    record.inFlightStartedAt &&
    record.inFlightStartedAt > staleBefore
  ) {
    return "busy";
  }
  return null;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === 11000
  );
}
