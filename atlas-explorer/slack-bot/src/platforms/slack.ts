import {
  createSlackAdapter,
  type SlackAdapter,
  type SlackAdapterMode,
} from "@chat-adapter/slack";
import type { Chat } from "chat";

import type { DeliveryBoundary } from "../chat/surface.js";

const RESPONSE_METADATA_EVENT = "atlas_explorer_responded";
const MAX_SLACK_TEXT_LENGTH = 38_000;

const SUGGESTED_PROMPTS = [
  {
    title: "List Atlas projects",
    message: "List the Atlas projects I can access.",
  },
  {
    title: "Inspect collections",
    message: "Show the collections in my MongoDB databases.",
  },
  {
    title: "Explain a query plan",
    message: "Help me understand and optimize a MongoDB query plan.",
  },
];

export interface SlackPlatformOptions {
  appToken?: string;
  botToken: string;
  displayName: string;
  mode: SlackAdapterMode;
  signingSecret?: string;
}

export function createSlackPlatformAdapter(
  options: SlackPlatformOptions,
): SlackAdapter {
  return createSlackAdapter({
    agentView: true,
    botToken: options.botToken,
    mode: options.mode,
    userName: options.displayName,
    suggestedPrompts: {
      title: "Explore MongoDB Atlas",
      prompts: SUGGESTED_PROMPTS,
    },
    sessionTitle: true,
    webClientOptions: {
      timeout: 30_000,
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
    },
    ...(options.appToken ? { appToken: options.appToken } : {}),
    ...(options.signingSecret
      ? { signingSecret: options.signingSecret }
      : {}),
  });
}

export function createSlackDeliveryBoundary(
  adapter: SlackAdapter,
): DeliveryBoundary {
  return {
    async deliver(thread, text, deliveryId): Promise<void> {
      const { channel, threadTs } = adapter.decodeThreadId(thread.id);
      await adapter.webClient.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: truncateSlackResponse(text),
        metadata: {
          event_type: RESPONSE_METADATA_EVENT,
          event_payload: { delivery_id: deliveryId },
        },
      });
    },

    async getDeliveryStatus(thread, deliveryId) {
      const { channel, threadTs } = adapter.decodeThreadId(thread.id);
      let cursor: string | undefined;
      try {
        do {
          const page = await adapter.webClient.conversations.replies({
            channel,
            ts: threadTs,
            include_all_metadata: true,
            limit: 100,
            ...(cursor ? { cursor } : {}),
          });
          if (
            page.messages?.some(
              (message) =>
                message.metadata?.event_type ===
                  RESPONSE_METADATA_EVENT &&
                (
                  message.metadata
                    .event_payload as Record<string, unknown>
                )?.delivery_id === deliveryId,
            )
          ) {
            return "delivered";
          }
          cursor =
            page.response_metadata?.next_cursor?.trim() || undefined;
        } while (cursor);
        return "not_delivered";
      } catch {
        return "unknown";
      }
    },
  };
}

export function registerSlackPlatformHandlers(
  chat: Chat,
  adapter: SlackAdapter,
  displayName: string,
): void {
  chat.onAppHomeOpened(async (event) => {
    if (event.adapter !== adapter || event.tab === "messages") {
      return;
    }
    await adapter.publishHomeView(
      event.userId,
      buildSlackHomeView(displayName),
    );
  });
}

export function truncateSlackResponse(text: string): string {
  if (text.length <= MAX_SLACK_TEXT_LENGTH) {
    return text;
  }
  const suffix = "\n\n_[Response truncated for Slack.]_";
  return `${text.slice(0, MAX_SLACK_TEXT_LENGTH - suffix.length)}${suffix}`;
}

export function parseSlackReviewInterruptId(
  value: string,
  signedThreadId: string,
): string | null {
  if (!value.startsWith("{")) {
    return value;
  }
  try {
    const parsed = JSON.parse(value) as {
      channelId?: unknown;
      interruptId?: unknown;
      threadTs?: unknown;
    };
    if (
      typeof parsed.channelId !== "string" ||
      !parsed.channelId ||
      typeof parsed.threadTs !== "string" ||
      !parsed.threadTs ||
      typeof parsed.interruptId !== "string" ||
      !parsed.interruptId ||
      `slack:${parsed.channelId}:${parsed.threadTs}` !==
        signedThreadId
    ) {
      return null;
    }
    return parsed.interruptId;
  } catch {
    return null;
  }
}

function buildSlackHomeView(displayName: string) {
  return {
    type: "home",
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `Welcome to ${displayName}`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Explore MongoDB databases and Atlas resources from Slack. Send a DM or mention this app in a channel, then keep follow-ups in the same thread.",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Try asking:*\n• List the Atlas projects I can access\n• Show the collections in a database\n• Explain and optimize a MongoDB query plan",
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "This demo uses the Atlas credentials configured on its shared Magenta workspace. Atlas access is not scoped to your chat identity.",
          },
        ],
      },
    ],
  };
}
