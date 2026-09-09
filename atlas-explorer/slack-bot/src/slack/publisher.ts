import type { KnownBlock } from "@slack/types";

import type { SlackPublisher } from "./handleUserMessage.js";

interface SlackApiClient {
  postMessage(input: {
    channel: string;
    thread_ts: string;
    text: string;
    blocks?: KnownBlock[];
    metadata?: SlackMessageMetadata;
  }): Promise<unknown>;
  updateMessage(input: {
    channel: string;
    ts: string;
    text: string;
    blocks: KnownBlock[];
  }): Promise<unknown>;
  setStatus(input: {
    channel_id: string;
    thread_ts: string;
    status: string;
  }): Promise<unknown>;
  getReplies(input: {
    channel: string;
    ts: string;
    cursor?: string;
    include_all_metadata: true;
    limit: number;
  }): Promise<{
    messages?: Array<{ metadata?: SlackMessageMetadata }>;
    response_metadata?: { next_cursor?: string };
  }>;
}

interface SlackMessageMetadata {
  event_type?: string;
  event_payload?: Record<string, unknown>;
}

interface SlackPublisherOptions {
  channelId: string;
  threadTs: string;
  reviewMessageTs?: string;
  client: SlackApiClient;
  say?: (input: {
    text: string;
    thread_ts: string;
    blocks?: KnownBlock[];
    metadata?: SlackMessageMetadata;
  }) => Promise<unknown>;
  setStatus?: (status: string) => Promise<unknown>;
}

const RESPONSE_METADATA_EVENT = "atlas_explorer_responded";

export function createSlackPublisher(
  options: SlackPublisherOptions,
): SlackPublisher {
  const postMessage = async (message: {
    text: string;
    blocks?: KnownBlock[];
  }): Promise<void> => {
    const input = {
      text: message.text,
      thread_ts: options.threadTs,
      ...(message.blocks ? { blocks: message.blocks } : {}),
    };
    if (options.say) {
      await options.say(input);
      return;
    }
    await options.client.postMessage({
      channel: options.channelId,
      ...input,
    });
  };

  return {
    async setStatus(status: string): Promise<void> {
      if (options.setStatus) {
        await options.setStatus(status);
        return;
      }
      await options.client.setStatus({
        channel_id: options.channelId,
        thread_ts: options.threadTs,
        status,
      });
    },

    postMessage,

    async postAgentResponse(
      text: string,
      deliveryId: string,
    ): Promise<void> {
      const input = {
        text,
        thread_ts: options.threadTs,
        metadata: {
          event_type: RESPONSE_METADATA_EVENT,
          event_payload: { delivery_id: deliveryId },
        },
      };
      if (options.say) {
        await options.say(input);
        return;
      }
      await options.client.postMessage({
        channel: options.channelId,
        ...input,
      });
    },

    async hasAgentResponse(deliveryId: string): Promise<boolean> {
      let cursor: string | undefined;
      do {
        const page = await options.client.getReplies({
          channel: options.channelId,
          ts: options.threadTs,
          include_all_metadata: true,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        if (
          page.messages?.some(
            (message) =>
              message.metadata?.event_type === RESPONSE_METADATA_EVENT &&
              message.metadata.event_payload?.delivery_id === deliveryId,
          )
        ) {
          return true;
        }
        cursor = page.response_metadata?.next_cursor?.trim() || undefined;
      } while (cursor);
      return false;
    },

    async updateReviewStatus(status): Promise<void> {
      if (!options.reviewMessageTs) {
        return;
      }
      const text = {
        approved: "Approved by the requester. Atlas Explorer is continuing.",
        rejected:
          "Rejected by the requester. Atlas Explorer will not run this operation.",
        uncertain:
          "Decision submitted, but its outcome could not be confirmed. Check Atlas before retrying.",
      }[status];
      await options.client.updateMessage({
        channel: options.channelId,
        ts: options.reviewMessageTs,
        text,
        blocks: [],
      });
    },
  };
}
