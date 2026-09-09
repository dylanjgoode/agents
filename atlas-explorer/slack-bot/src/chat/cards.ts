import {
  Actions,
  Button,
  Card,
  CardText,
  type PostableCard,
} from "chat";

import type { AgentActionRequest } from "../magenta/types.js";

export const REVIEW_APPROVE_ACTION_ID =
  "atlas_explorer_review_approve";
export const REVIEW_REJECT_ACTION_ID =
  "atlas_explorer_review_reject";

const MAX_DISPLAYED_ACTIONS = 45;
const MAX_ARGUMENT_TEXT = 1_800;

export function buildReviewCard(
  actions: AgentActionRequest[],
  interruptId: string,
): PostableCard {
  const displayedActions = actions.slice(0, MAX_DISPLAYED_ACTIONS);
  const canApproveAll = displayedActions.length === actions.length;
  const overflowCount = actions.length - displayedActions.length;
  const toolNames = actions.map((action) => action.name).join(", ");
  const children = displayedActions.map((action) =>
    CardText(actionSummary(action)),
  );

  children.push(
    CardText(
      canApproveAll
        ? "Only the person who requested this operation can decide it."
        : `${overflowCount} additional action${overflowCount === 1 ? "" : "s"} do not fit in this chat card. Approve this batch from Agentic Playground or the CLI; this chat can only reject it safely.`,
      { style: "muted" },
    ),
  );

  const controls = [
    ...(canApproveAll
      ? [
          Button({
            id: REVIEW_APPROVE_ACTION_ID,
            label: "Approve",
            style: "primary" as const,
            value: interruptId,
          }),
        ]
      : []),
    Button({
      id: REVIEW_REJECT_ACTION_ID,
      label: "Reject",
      style: "danger",
      value: interruptId,
    }),
  ];

  return {
    card: Card({
      title: "Atlas operation requires approval",
      children: [...children, Actions(controls)],
    }),
    fallbackText:
      `${toolNames} requires approval before Atlas Explorer can continue.`.slice(
        0,
        38_000,
      ),
  };
}

function actionSummary(action: AgentActionRequest): string {
  const argumentsText = JSON.stringify(action.args, null, 2);
  const truncatedArguments =
    argumentsText.length > MAX_ARGUMENT_TEXT
      ? `${argumentsText.slice(0, MAX_ARGUMENT_TEXT - 3)}...`
      : argumentsText;
  const description = action.description
    ? `${action.description.slice(0, 700)}\n`
    : "";
  return `**${action.name}**\n${description}\`\`\`\n${truncatedArguments}\n\`\`\``;
}
