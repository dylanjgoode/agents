import type { SlackAdapter } from "@chat-adapter/slack";
import type {
  AppHomeOpenedEvent,
  Chat,
  Thread,
} from "chat";
import { describe, expect, it, vi } from "vitest";

import {
  createSlackDeliveryBoundary,
  parseSlackReviewInterruptId,
  registerSlackPlatformHandlers,
  truncateSlackResponse,
} from "./slack.js";

describe("Slack platform boundary", () => {
  it("posts durable responses with Slack-only delivery metadata", async () => {
    const postMessage = vi.fn().mockResolvedValue({ ts: "2" });
    const adapter = fakeSlackAdapter({ postMessage });
    const boundary = createSlackDeliveryBoundary(adapter);

    await boundary.deliver(
      fakeThread(adapter),
      "Three projects found.",
      "delivery-1",
    );

    expect(postMessage).toHaveBeenCalledWith({
      channel: "C123",
      thread_ts: "1720000000.000100",
      text: "Three projects found.",
      metadata: {
        event_type: "atlas_explorer_responded",
        event_payload: { delivery_id: "delivery-1" },
      },
    });
  });

  it("reconciles accepted responses across paginated Slack replies", async () => {
    const replies = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [],
        response_metadata: { next_cursor: "next" },
      })
      .mockResolvedValueOnce({
        messages: [
          {
            metadata: {
              event_type: "atlas_explorer_responded",
              event_payload: { delivery_id: "delivery-1" },
            },
          },
        ],
      });
    const adapter = fakeSlackAdapter({ replies });
    const boundary = createSlackDeliveryBoundary(adapter);

    await expect(
      boundary.getDeliveryStatus(
        fakeThread(adapter),
        "delivery-1",
      ),
    ).resolves.toBe("delivered");

    expect(replies).toHaveBeenNthCalledWith(2, {
      channel: "C123",
      ts: "1720000000.000100",
      include_all_metadata: true,
      limit: 100,
      cursor: "next",
    });
  });

  it("keeps Slack size limits out of the shared core", () => {
    const oversized = "x".repeat(40_000);

    const truncated = truncateSlackResponse(oversized);

    expect(truncated.length).toBeLessThanOrEqual(38_000);
    expect(truncated).toMatch(/truncated for Slack/i);
  });

  it("accepts legacy review values only when signed thread context matches", () => {
    const value = JSON.stringify({
      channelId: "C123",
      threadTs: "1720000000.000100",
      interruptId: "interrupt-1",
    });

    expect(
      parseSlackReviewInterruptId(
        value,
        "slack:C123:1720000000.000100",
      ),
    ).toBe("interrupt-1");
    expect(
      parseSlackReviewInterruptId(
        value,
        "slack:C999:1720000000.000100",
      ),
    ).toBeNull();
    expect(
      parseSlackReviewInterruptId(
        "interrupt-2",
        "slack:C123:1720000000.000100",
      ),
    ).toBe("interrupt-2");
  });

  it("publishes Slack App Home only for the home tab", async () => {
    let handler:
      | ((event: AppHomeOpenedEvent) => Promise<void> | void)
      | undefined;
    const chat = {
      onAppHomeOpened(
        registered: (
          event: AppHomeOpenedEvent,
        ) => Promise<void> | void,
      ) {
        handler = registered;
      },
    } as unknown as Chat;
    const publishHomeView = vi.fn().mockResolvedValue(undefined);
    const adapter = {
      ...fakeSlackAdapter(),
      publishHomeView,
    } as unknown as SlackAdapter;
    registerSlackPlatformHandlers(chat, adapter, "AtlasExplorer");

    await handler?.({
      adapter,
      channelId: "D123",
      tab: "messages",
      userId: "U123",
    });
    await handler?.({
      adapter,
      channelId: "D123",
      tab: "home",
      userId: "U123",
    });

    expect(publishHomeView).toHaveBeenCalledTimes(1);
    expect(publishHomeView).toHaveBeenCalledWith(
      "U123",
      expect.objectContaining({ type: "home" }),
    );
  });
});

function fakeSlackAdapter(
  overrides: {
    postMessage?: ReturnType<typeof vi.fn>;
    replies?: ReturnType<typeof vi.fn>;
  } = {},
): SlackAdapter {
  return {
    name: "slack",
    decodeThreadId: () => ({
      channel: "C123",
      threadTs: "1720000000.000100",
    }),
    webClient: {
      chat: {
        postMessage:
          overrides.postMessage ??
          vi.fn().mockResolvedValue({ ts: "2" }),
      },
      conversations: {
        replies:
          overrides.replies ??
          vi.fn().mockResolvedValue({ messages: [] }),
      },
    },
  } as unknown as SlackAdapter;
}

function fakeThread(adapter: SlackAdapter): Thread {
  return {
    adapter,
    id: "slack:C123:1720000000.000100",
  } as unknown as Thread;
}
