import { describe, expect, it } from "vitest";

import { MemoryThreadStore } from "../src/store/memoryThreadStore.js";
import { MongoThreadStore } from "../src/store/mongoThreadStore.js";
import type {
  ThreadRecord,
  ThreadStore,
} from "../src/store/threadStore.js";

const baseRecord: Omit<ThreadRecord, "updatedAt"> = {
  channelId: "C123",
  threadTs: "1720000000.000100",
  magentaSessionId: "session-1",
};

async function exercisesRoundTrip(store: ThreadStore): Promise<void> {
  const record = {
    ...baseRecord,
    pendingExecutionId: "execution-1",
    pendingInterruptId: "interrupt-1",
    pendingResumeSchema: { type: "object" },
    pendingRequestedBySlackUserId: "U123",
    updatedAt: new Date("2026-09-08T12:00:00.000Z"),
  };

  await store.put(record);

  expect(await store.get(record.channelId, record.threadTs)).toEqual(record);
  expect(await store.get("C-other", record.threadTs)).toBeNull();
}

async function exercisesReviewClaim(store: ThreadStore): Promise<void> {
  await store.put({
    ...baseRecord,
    pendingExecutionId: "execution-1",
    pendingInterruptId: "interrupt-1",
    pendingReviewState: "pending",
    updatedAt: new Date("2026-09-08T12:00:00.000Z"),
  });

  const claims = await Promise.all([
    store.claimPendingReview(
      baseRecord.channelId,
      baseRecord.threadTs,
      "interrupt-1",
      new Date("2026-09-08T12:01:00.000Z"),
    ),
    store.claimPendingReview(
      baseRecord.channelId,
      baseRecord.threadTs,
      "interrupt-1",
      new Date("2026-09-08T12:01:00.000Z"),
    ),
  ]);

  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(claims.find(Boolean)).toMatchObject({
    pendingInterruptId: "interrupt-1",
    pendingReviewState: "resuming",
  });
  await store.put({
    ...baseRecord,
    pendingExecutionId: "execution-2",
    pendingInterruptId: "interrupt-2",
    pendingReviewState: "pending",
    updatedAt: new Date("2026-09-08T12:02:00.000Z"),
  });
  expect(
    await store.replaceClaimedReview("interrupt-1", {
      ...baseRecord,
      updatedAt: new Date("2026-09-08T12:02:01.000Z"),
    }),
  ).toBe(false);
  expect(
    await store.claimPendingReview(
      baseRecord.channelId,
      baseRecord.threadTs,
      "stale-interrupt",
      new Date(),
    ),
  ).toBeNull();
  await expect(
    store.get(baseRecord.channelId, baseRecord.threadTs),
  ).resolves.toMatchObject({
    pendingInterruptId: "interrupt-2",
  });
}

async function exercisesTurnClaim(store: ThreadStore): Promise<void> {
  const [first, duplicate] = await Promise.all([
    store.claimTurn(
      baseRecord.channelId,
      baseRecord.threadTs,
      "event-1",
      new Date("2026-09-08T12:00:00.000Z"),
    ),
    store.claimTurn(
      baseRecord.channelId,
      baseRecord.threadTs,
      "event-1",
      new Date("2026-09-08T12:00:00.000Z"),
    ),
  ]);

  expect([first.status, duplicate.status].sort()).toEqual([
    "claimed",
    "duplicate",
  ]);
  expect(
    (
      await store.claimTurn(
        baseRecord.channelId,
        baseRecord.threadTs,
        "event-2",
        new Date("2026-09-08T12:01:00.000Z"),
      )
    ).status,
  ).toBe("busy");

  const active = await store.get(baseRecord.channelId, baseRecord.threadTs);
  expect(active).not.toBeNull();
  await store.put({
    ...active!,
    inFlightEventId: undefined,
    inFlightStartedAt: undefined,
  });
  const next = await store.claimTurn(
    baseRecord.channelId,
    baseRecord.threadTs,
    "event-2",
    new Date("2026-09-08T12:02:00.000Z"),
  );
  expect(next.status).toBe("claimed");
  const {
    inFlightEventId: _eventId,
    inFlightStartedAt: _startedAt,
    ...finishedRecord
  } = next.record;
  expect(
    await store.replaceClaimedTurn("event-1", {
      ...finishedRecord,
      magentaSessionId: "stale-session",
      updatedAt: new Date("2026-09-08T12:02:01.000Z"),
    }),
  ).toBe(false);
  expect(
    await store.replaceClaimedTurn("event-2", {
      ...finishedRecord,
      magentaSessionId: "current-session",
      updatedAt: new Date("2026-09-08T12:02:01.000Z"),
    }),
  ).toBe(true);
  await expect(
    store.get(baseRecord.channelId, baseRecord.threadTs),
  ).resolves.toMatchObject({
    magentaSessionId: "current-session",
  });
}

async function exercisesDeliveryCompletion(store: ThreadStore): Promise<void> {
  await store.put({
    ...baseRecord,
    pendingDelivery: {
      id: "delivery-1",
      text: "Recovered response",
      state: "pending",
    },
    updatedAt: new Date("2026-09-08T12:00:00.000Z"),
  });

  const claims = await Promise.all([
    store.claimPendingDelivery(
      baseRecord.channelId,
      baseRecord.threadTs,
      "delivery-1",
      "claim-1",
      new Date("2026-09-08T12:01:00.000Z"),
    ),
    store.claimPendingDelivery(
      baseRecord.channelId,
      baseRecord.threadTs,
      "delivery-1",
      "claim-2",
      new Date("2026-09-08T12:01:00.000Z"),
    ),
  ]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  const claimed = claims.find(Boolean)!;
  expect(claimed.state).toBe("sending");
  expect(
    await store.clearPendingDelivery(
      baseRecord.channelId,
      baseRecord.threadTs,
      "delivery-1",
      claimed.claimId === "claim-1" ? "claim-2" : "claim-1",
    ),
  ).toBe(false);
  const reclaimed = await store.claimPendingDelivery(
    baseRecord.channelId,
    baseRecord.threadTs,
    "delivery-1",
    "claim-3",
    new Date("2026-09-08T12:07:00.000Z"),
  );
  expect(reclaimed).toMatchObject({
    claimId: "claim-3",
    attemptCount: 2,
  });
  expect(
    await store.clearPendingDelivery(
      baseRecord.channelId,
      baseRecord.threadTs,
      "delivery-1",
      claimed.claimId!,
    ),
  ).toBe(false);
  expect(
    await store.clearPendingDelivery(
      baseRecord.channelId,
      baseRecord.threadTs,
      "delivery-1",
      "claim-3",
    ),
  ).toBe(true);
  await expect(
    store.get(baseRecord.channelId, baseRecord.threadTs),
  ).resolves.toEqual(
    expect.not.objectContaining({
      pendingDelivery: expect.anything(),
    }),
  );
}

describe("MemoryThreadStore", () => {
  it("round-trips a Slack-to-Magenta thread record", async () => {
    await exercisesRoundTrip(new MemoryThreadStore());
  });

  it("expires records after the configured TTL", async () => {
    let now = Date.parse("2026-09-08T12:00:00.000Z");
    const store = new MemoryThreadStore({
      ttlMs: 60_000,
      now: () => now,
    });
    await store.put({
      ...baseRecord,
      updatedAt: new Date(now),
    });

    now += 60_001;

    expect(await store.get(baseRecord.channelId, baseRecord.threadTs)).toBeNull();
  });

  it("evicts the least recently updated record at capacity", async () => {
    const store = new MemoryThreadStore({ maxEntries: 2 });
    await store.put({
      ...baseRecord,
      threadTs: "1",
      updatedAt: new Date("2026-09-08T12:00:00.000Z"),
    });
    await store.put({
      ...baseRecord,
      threadTs: "2",
      updatedAt: new Date("2026-09-08T12:01:00.000Z"),
    });
    await store.put({
      ...baseRecord,
      threadTs: "3",
      updatedAt: new Date("2026-09-08T12:02:00.000Z"),
    });

    expect(await store.get(baseRecord.channelId, "1")).toBeNull();
    expect(await store.get(baseRecord.channelId, "2")).not.toBeNull();
    expect(await store.get(baseRecord.channelId, "3")).not.toBeNull();
  });

  it("atomically claims one reviewer for the pending interrupt", async () => {
    await exercisesReviewClaim(new MemoryThreadStore());
  });

  it("deduplicates events and serializes turns in a Slack thread", async () => {
    await exercisesTurnClaim(new MemoryThreadStore());
  });

  it("conditionally clears a delivered Slack response", async () => {
    await exercisesDeliveryCompletion(new MemoryThreadStore());
  });
});

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
