import type { ThreadStore } from "../store/threadStore.js";
import type { UserMessageInput } from "./handleUserMessage.js";

export interface SlackMessageEventLike {
  channel?: string;
  channel_type?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
}

export type SlackMessageSource = "message" | "mention";

export async function routeSlackMessage(
  event: SlackMessageEventLike,
  source: SlackMessageSource,
  store: ThreadStore,
  botUserId?: string,
  eventId?: string,
): Promise<UserMessageInput | null> {
  if (
    event.bot_id ||
    event.subtype ||
    !event.channel ||
    !event.ts ||
    !event.user
  ) {
    return null;
  }

  const threadTs = event.thread_ts ?? event.ts;
  if (source === "message") {
    if (
      event.channel_type !== "im" &&
      botUserId &&
      event.text?.includes(`<@${botUserId}>`)
    ) {
      return null;
    }
    const isDirectMessage = event.channel_type === "im";
    const isOwnedThread =
      Boolean(event.thread_ts) &&
      Boolean(await store.get(event.channel, threadTs));
    if (!isDirectMessage && !isOwnedThread) {
      return null;
    }
  }

  const shouldStripBotMention =
    source === "mention" ||
    (source === "message" && event.channel_type === "im" && botUserId);
  const text = shouldStripBotMention
    ? stripBotMention(event.text ?? "", botUserId)
    : (event.text ?? "");

  return {
    channelId: event.channel,
    threadTs,
    ...(eventId ? { eventId } : {}),
    slackUserId: event.user,
    text,
  };
}

function stripBotMention(text: string, botUserId?: string): string {
  if (botUserId) {
    return text.replaceAll(`<@${botUserId}>`, "").trim();
  }
  return text.replace(/<@[A-Z0-9-]+>/gi, "").trim();
}
