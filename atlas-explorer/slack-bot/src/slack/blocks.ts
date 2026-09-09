import type { HomeView, KnownBlock } from "@slack/types";

import type { AgentActionRequest } from "../magenta/types.js";

export const REVIEW_APPROVE_ACTION_ID = "atlas_explorer_review_approve";
export const REVIEW_REJECT_ACTION_ID = "atlas_explorer_review_reject";

interface ReviewTarget {
  channelId: string;
  threadTs: string;
  interruptId: string;
}

function escapeMrkdwn(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function actionSummary(action: AgentActionRequest): string {
  const args = JSON.stringify(action.args, null, 2);
  const truncatedArgs =
    args.length > 1_800 ? `${args.slice(0, 1_797)}...` : args;
  const description = action.description
    ? `${escapeMrkdwn(action.description).slice(0, 700)}\n`
    : "";
  const summary = `*${escapeMrkdwn(action.name)}*\n${description}\`\`\`${escapeMrkdwn(truncatedArgs)}\`\`\``;
  return summary.length <= 3_000
    ? summary
    : `${summary.slice(0, 2_995)}…\n\`\`\``;
}

export function buildReviewMessage(
  actions: AgentActionRequest[],
  target: ReviewTarget,
): { text: string; blocks: KnownBlock[] } {
  const toolNames = actions.map((action) => action.name).join(", ");
  const value = JSON.stringify(target);
  const displayedActions = actions.slice(0, 45);
  const canApproveAll = displayedActions.length === actions.length;
  const overflowWarning = canApproveAll
    ? "Only the Slack user who requested this operation can decide it."
    : `${actions.length - displayedActions.length} additional actions do not fit in Slack. Approve this batch from Agentic Playground or the CLI; Slack can only reject it safely.`;
  return {
    text: `${toolNames} requires approval before Atlas Explorer can continue.`.slice(
      0,
      38_000,
    ),
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "Atlas operation requires approval",
        },
      },
      ...displayedActions.map(
        (action): KnownBlock => ({
          type: "section",
          text: {
            type: "mrkdwn",
            text: actionSummary(action),
          },
        }),
      ),
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: overflowWarning,
          },
        ],
      },
      {
        type: "actions",
        elements: [
          ...(canApproveAll
            ? [
                {
                  type: "button" as const,
                  action_id: REVIEW_APPROVE_ACTION_ID,
                  text: { type: "plain_text" as const, text: "Approve" },
                  style: "primary" as const,
                  value,
                },
              ]
            : []),
          {
            type: "button",
            action_id: REVIEW_REJECT_ACTION_ID,
            text: { type: "plain_text", text: "Reject" },
            style: "danger",
            value,
            confirm: {
              title: { type: "plain_text", text: "Reject operation?" },
              text: {
                type: "mrkdwn",
                text: "Atlas Explorer will not execute the pending operation.",
              },
              confirm: { type: "plain_text", text: "Reject" },
              deny: { type: "plain_text", text: "Cancel" },
            },
          },
        ],
      },
    ],
  };
}

export function parseReviewTarget(value: string): ReviewTarget | null {
  try {
    const parsed = JSON.parse(value) as Partial<ReviewTarget>;
    if (
      typeof parsed.channelId !== "string" ||
      !parsed.channelId ||
      typeof parsed.threadTs !== "string" ||
      !parsed.threadTs ||
      typeof parsed.interruptId !== "string" ||
      !parsed.interruptId
    ) {
      return null;
    }
    return {
      channelId: parsed.channelId,
      threadTs: parsed.threadTs,
      interruptId: parsed.interruptId,
    };
  } catch {
    return null;
  }
}

export function buildAppHomeView(displayName: string): HomeView {
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
            text: "This demo uses the Atlas credentials configured on its shared Magenta workspace. Atlas access is not scoped to your Slack identity.",
          },
        ],
      },
    ],
  };
}
