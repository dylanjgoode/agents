import { describe, expect, it } from "vitest";

import {
  REVIEW_APPROVE_ACTION_ID,
  REVIEW_REJECT_ACTION_ID,
  buildReviewMessage,
  parseReviewTarget,
} from "../src/slack/blocks.js";

describe("buildReviewMessage", () => {
  it("shows every action that an approval decision will cover", () => {
    const actions = Array.from({ length: 6 }, (_, index) => ({
      name: `mutation_${index + 1}`,
      args: { index: index + 1 },
    }));

    const message = buildReviewMessage(actions, {
      channelId: "C123",
      threadTs: "1720000000.000100",
      interruptId: "interrupt-1",
    });
    const renderedText = message.blocks
      .flatMap((block) =>
        block.type === "section" && block.text ? [block.text.text] : [],
      )
      .join("\n");

    for (const action of actions) {
      expect(renderedText).toContain(action.name);
    }
  });

  it("binds review buttons to the interrupt they display", () => {
    const message = buildReviewMessage(
      [{ name: "mongodb__insert_many", args: { count: 1 } }],
      {
        channelId: "C123",
        threadTs: "1720000000.000100",
        interruptId: "interrupt-1",
      },
    );
    const actions = message.blocks.find((block) => block.type === "actions");
    const button =
      actions?.type === "actions" && actions.elements[0]?.type === "button"
        ? actions.elements[0]
        : undefined;

    expect(parseReviewTarget(button?.value ?? "")).toEqual({
      channelId: "C123",
      threadTs: "1720000000.000100",
      interruptId: "interrupt-1",
    });
  });

  it("does not offer approval when not every action can be displayed", () => {
    const message = buildReviewMessage(
      Array.from({ length: 46 }, (_, index) => ({
        name: `mutation_${index + 1}`,
        args: { index },
      })),
      {
        channelId: "C123",
        threadTs: "1720000000.000100",
        interruptId: "interrupt-1",
      },
    );
    const actions = message.blocks.find((block) => block.type === "actions");
    const actionIds =
      actions?.type === "actions"
        ? actions.elements.flatMap((element) =>
            "action_id" in element ? [element.action_id] : [],
          )
        : [];

    expect(actionIds).not.toContain(REVIEW_APPROVE_ACTION_ID);
    expect(actionIds).toContain(REVIEW_REJECT_ACTION_ID);
  });

  it("keeps escaped action summaries within Slack section limits", () => {
    const message = buildReviewMessage(
      [
        {
          name: "&".repeat(1_000),
          args: { value: "&".repeat(1_800) },
        },
      ],
      {
        channelId: "C123",
        threadTs: "1720000000.000100",
        interruptId: "interrupt-1",
      },
    );
    const sectionLengths = message.blocks.flatMap((block) =>
      block.type === "section" && block.text
        ? [block.text.text.length]
        : [],
    );

    expect(sectionLengths.every((length) => length <= 3_000)).toBe(true);
  });
});
