import { describe, expect, it } from "vitest";

import { MongoThreadStore } from "./mongoThreadStore.js";
import type { ThreadRecord } from "./threadStore.js";
import {
  exercisesDeliveryCompletion,
  exercisesReviewClaim,
  exercisesRoundTrip,
  exercisesTurnClaim,
} from "./threadStore.test-helpers.js";

interface StoredDocument extends ThreadRecord {
  _id: string;
}

interface TestIndexOptions {
  unique?: boolean;
  name?: string;
  expireAfterSeconds?: number;
  partialFilterExpression?: Record<string, unknown>;
}

class FakeCollection {
  readonly documents = new Map<string, StoredDocument>();
  indexes: Array<{
    keys: Record<string, 1 | -1>;
    options: TestIndexOptions;
  }> = [];

  async createIndex(
    keys: Record<string, 1 | -1>,
    options: TestIndexOptions,
  ): Promise<string> {
    this.indexes.push({ keys, options });
    return options.name ?? "index";
  }

  async findOne(filter: { _id: string }): Promise<StoredDocument | null> {
    return this.documents.get(filter._id) ?? null;
  }

  async replaceOne(
    filter: Record<string, unknown>,
    replacement: StoredDocument,
    options: { upsert: boolean },
  ): Promise<{ matchedCount: number }> {
    const key = String(filter._id);
    const existing = this.documents.get(key);
    if (!existing) {
      if (options.upsert) {
        this.documents.set(key, structuredClone(replacement));
      }
      return { matchedCount: 0 };
    }
    const matches = Object.entries(filter).every(
      ([field, value]) =>
        field === "_id" ||
        existing[field as keyof StoredDocument] === value,
    );
    if (!matches) {
      return { matchedCount: 0 };
    }
    this.documents.set(key, structuredClone(replacement));
    return { matchedCount: 1 };
  }

  async insertOne(document: StoredDocument): Promise<void> {
    if (this.documents.has(document._id)) {
      throw Object.assign(new Error("duplicate key"), { code: 11000 });
    }
    this.documents.set(document._id, structuredClone(document));
  }

  async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<StoredDocument | null> {
    const key = String(filter._id);
    const document = this.documents.get(key);
    if (!document) {
      return null;
    }

    if (typeof filter["pendingDelivery.id"] === "string") {
      if (
        document.pendingDelivery?.id !== filter["pendingDelivery.id"]
      ) {
        return null;
      }
      if (update.$unset) {
        if (
          document.pendingDelivery.claimId !==
          filter["pendingDelivery.claimId"]
        ) {
          return null;
        }
        const { pendingDelivery: _delivery, ...updated } = document;
        const retained = {
          ...updated,
          retentionState: "inactive" as const,
        };
        this.documents.set(key, structuredClone(retained));
        return structuredClone(retained);
      }

      const deliveryConditions = filter.$or as [
        { "pendingDelivery.state": { $in: Array<string | null> } },
        {
          "pendingDelivery.state": "sending";
          "pendingDelivery.claimedAt": { $lt: Date };
        },
      ];
      const delivery = document.pendingDelivery;
      const canClaim =
        deliveryConditions[0]["pendingDelivery.state"].$in.includes(
          delivery.state ?? null,
        ) ||
        (delivery.state === "sending" &&
          Boolean(delivery.claimedAt) &&
          delivery.claimedAt! <
            deliveryConditions[1]["pendingDelivery.claimedAt"].$lt);
      if (!canClaim) {
        return null;
      }
      const set = update.$set as Record<string, unknown>;
      const updated = {
        ...document,
        pendingDelivery: {
          ...delivery,
          state: set["pendingDelivery.state"] as "sending",
          attemptCount: (delivery.attemptCount ?? 0) + 1,
          claimId: set["pendingDelivery.claimId"] as string,
          claimedAt: set["pendingDelivery.claimedAt"] as Date,
        },
      };
      this.documents.set(key, structuredClone(updated));
      return structuredClone(updated);
    }

    if (typeof filter.pendingInterruptId === "string") {
      const reviewConditions = filter.$or as
        | [
            { pendingReviewState: { $in: Array<string | null> } },
            {
              pendingReviewState: "resuming";
              pendingReviewClaimedAt: { $lt: Date };
            },
          ]
        | undefined;
      const allowedStates = reviewConditions
        ? reviewConditions[0].pendingReviewState.$in
        : (
            filter.pendingReviewState as { $in: Array<string | null> }
          ).$in;
      const staleClaim =
        reviewConditions?.[1].pendingReviewClaimedAt.$lt;
      const canReclaim =
        document.pendingReviewState === "resuming" &&
        document.pendingReviewClaimedAt &&
        staleClaim &&
        document.pendingReviewClaimedAt < staleClaim;
      if (
        document.pendingInterruptId !== filter.pendingInterruptId ||
        (!allowedStates.includes(document.pendingReviewState ?? null) &&
          !canReclaim)
      ) {
        return null;
      }
    } else {
      const set = update.$set as Partial<StoredDocument>;
      const eventId = set.inFlightEventId;
      const andConditions = filter.$and as Array<{
        $or: Array<Record<string, { $lt?: Date } | null>>;
      }>;
      const staleBefore = (
        andConditions[1]?.$or[2]?.inFlightStartedAt as { $lt: Date }
      ).$lt;
      if (
        typeof eventId !== "string" ||
        document.recentSlackEventIds?.includes(eventId) ||
        document.pendingInterruptId ||
        (document.inFlightEventId &&
          document.inFlightStartedAt &&
          document.inFlightStartedAt > staleBefore)
      ) {
        return null;
      }
    }

    const set = update.$set as Partial<StoredDocument>;
    const updated = {
      ...document,
      ...set,
    };
    const unset = update.$unset as Record<string, unknown> | undefined;
    for (const field of Object.keys(unset ?? {})) {
      delete updated[field as keyof StoredDocument];
    }
    const push = update.$push as
      | {
          recentSlackEventIds: {
            $each: string[];
            $slice: number;
          };
        }
      | undefined;
    if (push) {
      updated.recentSlackEventIds = [
        ...(document.recentSlackEventIds ?? []),
        ...push.recentSlackEventIds.$each,
      ].slice(push.recentSlackEventIds.$slice);
    }
    this.documents.set(key, structuredClone(updated));
    return structuredClone(updated);
  }
}

describe("MongoThreadStore", () => {
  it("round-trips a Slack-to-Magenta thread record", async () => {
    const collection = new FakeCollection();
    await exercisesRoundTrip(new MongoThreadStore(collection));
  });

  it("creates a unique channel/thread index", async () => {
    const collection = new FakeCollection();
    const store = new MongoThreadStore(collection);

    await store.initialize();

    expect(collection.indexes).toEqual([
      {
        keys: { channelId: 1, threadTs: 1 },
        options: {
          name: "slack_thread_unique",
          unique: true,
        },
      },
      {
        keys: { updatedAt: 1 },
        options: {
          expireAfterSeconds: 2_592_000,
          name: "inactive_thread_ttl",
          partialFilterExpression: {
            retentionState: "inactive",
          },
        },
      },
      {
        keys: { updatedAt: 1 },
        options: {
          expireAfterSeconds: 86_400,
          name: "pending_delivery_ttl",
          partialFilterExpression: {
            retentionState: "delivery_pending",
          },
        },
      },
    ]);
  });

  it("initializes a lazy collection once before its first operation", async () => {
    const collection = new FakeCollection();
    const store = new MongoThreadStore(collection, {
      initializeOnAccess: true,
    });

    await store.get("C123", "1");
    await store.get("C123", "2");

    expect(collection.indexes).toHaveLength(3);
  });

  it("atomically claims one reviewer for the pending interrupt", async () => {
    await exercisesReviewClaim(new MongoThreadStore(new FakeCollection()));
  });

  it("deduplicates events and serializes turns in a Slack thread", async () => {
    await exercisesTurnClaim(new MongoThreadStore(new FakeCollection()));
  });

  it("conditionally clears a delivered Slack response", async () => {
    await exercisesDeliveryCompletion(
      new MongoThreadStore(new FakeCollection()),
    );
  });
});
