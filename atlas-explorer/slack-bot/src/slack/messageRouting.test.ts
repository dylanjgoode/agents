import { describe, expect, it } from "vitest";

import { MemoryThreadStore } from "../store/memoryThreadStore.js";
import { routeSlackMessage } from "./messageRouting.js";

describe("routeSlackMessage", () => {
  it("routes direct messages into a new Slack thread", async () => {
    const route = await routeSlackMessage(
      {
        channel: "D123",
        channel_type: "im",
        text: "List my Atlas projects",
        ts: "1720000000.000100",
        user: "U123",
      },
      "message",
      new MemoryThreadStore(),
    );

    expect(route).toEqual({
      channelId: "D123",
      slackUserId: "U123",
      text: "List my Atlas projects",
      threadTs: "1720000000.000100",
    });
  });

  it("strips the bot mention and routes a channel mention", async () => {
    const route = await routeSlackMessage(
      {
        channel: "C123",
        text: "<@U-BOT>   Show collections",
        ts: "1720000000.000100",
        user: "U123",
      },
      "mention",
      new MemoryThreadStore(),
    );

    expect(route).toEqual({
      channelId: "C123",
      slackUserId: "U123",
      text: "Show collections",
      threadTs: "1720000000.000100",
    });
  });

  it("routes channel thread replies only after Atlas Explorer joined", async () => {
    const store = new MemoryThreadStore();
    const event = {
      channel: "C123",
      channel_type: "channel",
      text: "What about the first one?",
      thread_ts: "1720000000.000100",
      ts: "1720000001.000100",
      user: "U123",
    };

    expect(await routeSlackMessage(event, "message", store)).toBeNull();

    await store.put({
      channelId: "C123",
      threadTs: "1720000000.000100",
      magentaSessionId: "session-1",
      updatedAt: new Date(),
    });

    expect(await routeSlackMessage(event, "message", store)).toEqual({
      channelId: "C123",
      slackUserId: "U123",
      text: "What about the first one?",
      threadTs: "1720000000.000100",
    });
  });

  it("ignores top-level channel messages without a mention", async () => {
    expect(
      await routeSlackMessage(
        {
          channel: "C123",
          channel_type: "channel",
          text: "General channel chatter",
          ts: "1720000000.000100",
          user: "U123",
        },
        "message",
        new MemoryThreadStore(),
      ),
    ).toBeNull();
  });

  it("ignores bot messages and message subtypes", async () => {
    const store = new MemoryThreadStore();
    const common = {
      channel: "D123",
      channel_type: "im",
      text: "Ignore me",
      ts: "1720000000.000100",
      user: "U123",
    };

    expect(
      await routeSlackMessage(
        { ...common, bot_id: "B123" },
        "message",
        store,
      ),
    ).toBeNull();
    expect(
      await routeSlackMessage(
        { ...common, subtype: "message_changed" },
        "message",
        store,
      ),
    ).toBeNull();
  });

  it("leaves bot mentions to the app_mention listener", async () => {
    const store = new MemoryThreadStore();
    await store.put({
      channelId: "C123",
      threadTs: "1720000000.000100",
      magentaSessionId: "session-1",
      updatedAt: new Date(),
    });

    expect(
      await routeSlackMessage(
        {
          channel: "C123",
          channel_type: "channel",
          text: "<@U-BOT> show collections",
          thread_ts: "1720000000.000100",
          ts: "1720000001.000100",
          user: "U123",
        },
        "message",
        store,
        "U-BOT",
      ),
    ).toBeNull();
  });

  it("keeps explicit mentions in DMs because app_mention is not emitted there", async () => {
    await expect(
      routeSlackMessage(
        {
          channel: "D123",
          channel_type: "im",
          text: "<@U-BOT> show collections",
          ts: "1720000000.000100",
          user: "U123",
        },
        "message",
        new MemoryThreadStore(),
        "U-BOT",
      ),
    ).resolves.toMatchObject({
      channelId: "D123",
      text: "show collections",
    });
  });
});
