/**
 * Copyright 2026 MongoDB, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { WhatsAppAdapter } from "@chat-adapter/whatsapp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TYPING_REFRESH_MS,
  WhatsAppPlatformAdapter,
} from "./whatsapp.js";

const THREAD_ID = "whatsapp:1234567890:15550001111";
const OTHER_THREAD_ID = "whatsapp:1234567890:15550002222";

describe("WhatsAppPlatformAdapter", () => {
  let now: number;
  let adapter: WhatsAppPlatformAdapter;
  let typing: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    now = 1_000_000;
    adapter = new WhatsAppPlatformAdapter({
      accessToken: "access-token",
      appSecret: "app-secret",
      displayName: "TestBot",
      now: () => now,
      phoneNumberId: "1234567890",
      verifyToken: "verify-token",
    });
    typing = vi
      .spyOn(WhatsAppAdapter.prototype, "startTyping")
      .mockResolvedValue();
    vi.spyOn(WhatsAppAdapter.prototype, "postMessage").mockResolvedValue({
      id: "wamid.sent",
      raw: {} as never,
      threadId: THREAD_ID,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the configured display name", () => {
    expect(adapter.userName).toBe("TestBot");
    expect(adapter.name).toBe("whatsapp");
  });

  it("sends one typing indicator per refresh interval, without status text", async () => {
    await adapter.startTyping(THREAD_ID, "Calling tool: find...");
    now += TYPING_REFRESH_MS - 1;
    await adapter.startTyping(THREAD_ID, "Calling tool: aggregate...");
    await adapter.startTyping(OTHER_THREAD_ID, "Initializing…");
    now += 1;
    await adapter.startTyping(THREAD_ID, "Calling tool: count...");

    expect(typing.mock.calls).toEqual([
      [THREAD_ID],
      [OTHER_THREAD_ID],
      [THREAD_ID],
    ]);
  });

  it("starts a fresh indicator after the bot replies", async () => {
    await adapter.startTyping(THREAD_ID);
    await adapter.postMessage(THREAD_ID, { markdown: "Done." });
    await adapter.startTyping(THREAD_ID);

    expect(typing).toHaveBeenCalledTimes(2);
  });
});
