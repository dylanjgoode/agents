import type {
  App,
  BlockAction,
  ButtonAction,
  Logger,
} from "@slack/bolt";

import type { AgentGateway, HandlerLogger } from "./handleUserMessage.js";
import { handleReviewDecision } from "./handleReviewAction.js";
import { handleUserMessage } from "./handleUserMessage.js";
import {
  buildAppHomeView,
  parseReviewTarget,
  REVIEW_APPROVE_ACTION_ID,
  REVIEW_REJECT_ACTION_ID,
} from "./blocks.js";
import { routeSlackMessage } from "./messageRouting.js";
import { createSlackPublisher } from "./publisher.js";
import type { ThreadStore } from "../store/threadStore.js";

export interface SlackListenerDependencies {
  agent: AgentGateway;
  store: ThreadStore;
  displayName: string;
  authorizedSlackUserIds?: ReadonlySet<string>;
}

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

export function registerSlackListeners(
  app: App,
  dependencies: SlackListenerDependencies,
): void {
  app.event("app_home_opened", async ({ client, event, logger }) => {
    try {
      if (event.tab === "messages") {
        await client.apiCall("assistant.threads.setSuggestedPrompts", {
          channel_id: event.channel,
          title: "Explore MongoDB Atlas",
          prompts: SUGGESTED_PROMPTS,
        });
        return;
      }

      await client.views.publish({
        user_id: event.user,
        view: buildAppHomeView(dependencies.displayName),
      });
    } catch (error) {
      logger.error("Failed to publish Atlas Explorer App Home", error);
    }
  });

  app.event(
    "app_mention",
    async ({
      body,
      client,
      context,
      event,
      logger,
      say,
      setStatus,
    }) => {
      const input = await routeSlackMessage(
        event,
        "mention",
        dependencies.store,
        context.botUserId,
        body.event_id,
      );
      if (!input) {
        return;
      }
      await handleUserMessage(input, {
        agent: dependencies.agent,
        store: dependencies.store,
        ...(dependencies.authorizedSlackUserIds
          ? { authorizedSlackUserIds: dependencies.authorizedSlackUserIds }
          : {}),
        logger: adaptLogger(logger),
        publisher: createSlackPublisher({
          channelId: input.channelId,
          threadTs: input.threadTs,
          client: adaptClient(client),
          say: (message) =>
            say(message as Parameters<typeof say>[0]),
          setStatus,
        }),
      });
    },
  );

  app.event(
    "message",
    async ({
      body,
      client,
      context,
      event,
      logger,
      say,
      setStatus,
    }) => {
      const input = await routeSlackMessage(
        event,
        "message",
        dependencies.store,
        context.botUserId,
        body.event_id,
      );
      if (!input) {
        return;
      }
      await handleUserMessage(input, {
        agent: dependencies.agent,
        store: dependencies.store,
        ...(dependencies.authorizedSlackUserIds
          ? { authorizedSlackUserIds: dependencies.authorizedSlackUserIds }
          : {}),
        logger: adaptLogger(logger),
        publisher: createSlackPublisher({
          channelId: input.channelId,
          threadTs: input.threadTs,
          client: adaptClient(client),
          say: (message) =>
            say(message as Parameters<typeof say>[0]),
          setStatus,
        }),
      });
    },
  );

  registerReviewAction(
    app,
    REVIEW_APPROVE_ACTION_ID,
    "approve",
    dependencies,
  );
  registerReviewAction(
    app,
    REVIEW_REJECT_ACTION_ID,
    "reject",
    dependencies,
  );
}

function registerReviewAction(
  app: App,
  actionId: string,
  decision: "approve" | "reject",
  dependencies: SlackListenerDependencies,
): void {
  app.action<BlockAction<ButtonAction>>(
    actionId,
    async ({ ack, action, body, client, logger, respond }) => {
      await ack();

      const target = parseReviewTarget(action.value ?? "");
      if (!target) {
        await respond({
          text: "This approval button is invalid or expired.",
          response_type: "ephemeral",
          replace_original: false,
        });
        return;
      }

      await handleReviewDecision(
        {
          ...target,
          slackUserId: body.user.id,
          decision,
        },
        {
          agent: dependencies.agent,
          store: dependencies.store,
          ...(dependencies.authorizedSlackUserIds
            ? { authorizedSlackUserIds: dependencies.authorizedSlackUserIds }
            : {}),
          logger: adaptLogger(logger),
          publisher: createSlackPublisher({
            channelId: target.channelId,
            threadTs: target.threadTs,
            reviewMessageTs: body.message?.ts,
            client: adaptClient(client),
          }),
        },
      );
    },
  );
}

function adaptLogger(logger: Logger): HandlerLogger {
  return {
    error(message, error): void {
      logger.error(message, error);
    },
    warn(message, error): void {
      logger.warn(message, error);
    },
  };
}

function adaptClient(client: App["client"]) {
  return {
    async postMessage(input: unknown) {
      return client.chat.postMessage(
        input as Parameters<typeof client.chat.postMessage>[0],
      );
    },
    async updateMessage(input: unknown) {
      return client.chat.update(
        input as Parameters<typeof client.chat.update>[0],
      );
    },
    async setStatus(input: unknown) {
      return client.assistant.threads.setStatus(
        input as Parameters<typeof client.assistant.threads.setStatus>[0],
      );
    },
    async getReplies(input: unknown) {
      return client.conversations.replies(
        input as Parameters<typeof client.conversations.replies>[0],
      );
    },
  };
}
