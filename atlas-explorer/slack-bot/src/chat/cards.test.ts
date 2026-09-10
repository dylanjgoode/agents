import type {
  ActionsElement,
  ButtonElement,
  PostableCard,
  TextElement,
} from "chat";
import { describe, expect, it } from "vitest";

import {
  buildReviewCard,
  REVIEW_APPROVE_ACTION_ID,
  REVIEW_REJECT_ACTION_ID,
} from "./cards.js";

describe("buildReviewCard", () => {
  it("creates cross-platform controls carrying only the interrupt ID", () => {
    const message = buildReviewCard(
      [
        {
          name: "mongodb__insert_many",
          args: { database: "inventory", count: 1 },
          description: "Insert one inventory item",
        },
      ],
      "interrupt-1",
    ) as PostableCard;

    expect(message.fallbackText).toMatch(/requires approval/i);
    expect(message.card.title).toMatch(/requires approval/i);
    expect(buttons(message)).toEqual([
      {
        type: "button",
        id: REVIEW_APPROVE_ACTION_ID,
        label: "Approve",
        style: "primary",
        value: "interrupt-1",
      },
      {
        type: "button",
        id: REVIEW_REJECT_ACTION_ID,
        label: "Reject",
        style: "danger",
        value: "interrupt-1",
      },
    ]);
    expect(JSON.stringify(message)).not.toMatch(/C123|threadTs|channelId/);
  });

  it("shows only a safe reject action when all operations do not fit", () => {
    const message = buildReviewCard(
      Array.from({ length: 46 }, (_, index) => ({
        name: `mutation_${index}`,
        args: { index },
      })),
      "interrupt-overflow",
    ) as PostableCard;

    expect(buttons(message).map((button) => button.id)).toEqual([
      REVIEW_REJECT_ACTION_ID,
    ]);
    const text = message.card.children
      .filter((child): child is TextElement => child.type === "text")
      .map((child) => child.content)
      .join("\n");
    expect(text).toMatch(/additional action/i);
  });
});

function buttons(message: PostableCard): ButtonElement[] {
  return message.card.children
    .filter(
      (child): child is ActionsElement => child.type === "actions",
    )
    .flatMap((actions) =>
      actions.children.filter(
        (child): child is ButtonElement => child.type === "button",
      ),
    );
}
