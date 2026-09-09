import { describe, expect, it, vi } from "vitest";

import { createSlackPublisher } from "./publisher.js";

describe("createSlackPublisher", () => {
  it("uses Bolt status and attaches a durable delivery ID to replies", async () => {
    const setStatus = vi.fn().mockResolvedValue(undefined);
    const say = vi.fn().mockResolvedValue(undefined);
    const publisher = createSlackPublisher({
      channelId: "C123",
      threadTs: "1720000000.000100",
      client: emptyClient(),
      say,
      setStatus,
    });

    await publisher.setStatus("Exploring Atlas…");
    await publisher.postAgentResponse(
      "Three projects found.",
      "delivery-1",
    );

    expect(setStatus).toHaveBeenCalledWith("Exploring Atlas…");
    expect(say).toHaveBeenCalledWith({
      metadata: {
        event_payload: { delivery_id: "delivery-1" },
        event_type: "atlas_explorer_responded",
      },
      text: "Three projects found.",
      thread_ts: "1720000000.000100",
    });
  });

  it("posts through the Web API when a Bolt say helper is unavailable", async () => {
    const client = emptyClient();
    const publisher = createSlackPublisher({
      channelId: "C123",
      threadTs: "1720000000.000100",
      client,
    });

    await publisher.postAgentResponse(
      "Three projects found.",
      "delivery-1",
    );

    expect(client.postMessage).toHaveBeenCalledWith({
      channel: "C123",
      metadata: {
        event_payload: { delivery_id: "delivery-1" },
        event_type: "atlas_explorer_responded",
      },
      text: "Three projects found.",
      thread_ts: "1720000000.000100",
    });
  });

  it("finds a previously accepted response by delivery metadata", async () => {
    const client = {
      ...emptyClient(),
      getReplies: vi.fn().mockResolvedValue({
        messages: [
          {
            metadata: {
              event_type: "atlas_explorer_responded",
              event_payload: { delivery_id: "delivery-1" },
            },
          },
        ],
      }),
    };
    const publisher = createSlackPublisher({
      channelId: "C123",
      threadTs: "1720000000.000100",
      client,
    });

    await expect(
      publisher.hasAgentResponse("delivery-1"),
    ).resolves.toBe(true);
  });

  it("updates the original review message after a decision", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const publisher = createSlackPublisher({
      channelId: "C123",
      threadTs: "1720000000.000100",
      reviewMessageTs: "1720000002.000100",
      client: {
        ...emptyClient(),
        updateMessage: update,
      },
    });

    await publisher.updateReviewStatus?.("approved");

    expect(update).toHaveBeenCalledWith({
      channel: "C123",
      ts: "1720000002.000100",
      text: "Approved by the requester. Atlas Explorer is continuing.",
      blocks: [],
    });
  });
});

function emptyClient() {
  return {
    postMessage: vi.fn().mockResolvedValue(undefined),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
    getReplies: vi.fn().mockResolvedValue({ messages: [] }),
  };
}
