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

import {
  WhatsAppAdapter,
  type WhatsAppRawMessage,
} from "@chat-adapter/whatsapp";
import {
  ConsoleLogger,
  type AdapterPostableMessage,
  type Logger,
  type RawMessage,
} from "chat";

// WhatsApp shows a typing indicator for up to 25 seconds, so refreshing it
// a little sooner keeps it visible through a long agent run.
export const TYPING_REFRESH_MS = 20_000;

export interface WhatsAppPlatformOptions {
  accessToken: string;
  apiUrl?: string;
  appSecret: string;
  displayName: string;
  logger?: Logger;
  now?: () => number;
  phoneNumberId: string;
  verifyToken: string;
}

/**
 * The Chat SDK WhatsApp adapter, with typing indicators throttled.
 *
 * The shared handlers report each step of an agent run as a status, and the
 * stock adapter turns every status into a Graph API call plus a warning that
 * WhatsApp can't show status text. This sends at most one typing indicator per
 * thread every {@link TYPING_REFRESH_MS}, without the text, and lets the next
 * turn start a fresh one as soon as the bot replies.
 */
export class WhatsAppPlatformAdapter extends WhatsAppAdapter {
  private readonly lastTypingAt = new Map<string, number>();
  private readonly now: () => number;

  constructor(options: WhatsAppPlatformOptions) {
    super({
      accessToken: options.accessToken,
      appSecret: options.appSecret,
      logger:
        options.logger ?? new ConsoleLogger("info").child("whatsapp"),
      phoneNumberId: options.phoneNumberId,
      userName: options.displayName,
      verifyToken: options.verifyToken,
      ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
    });
    this.now = options.now ?? Date.now;
  }

  override async startTyping(
    threadId: string,
    _status?: string,
  ): Promise<void> {
    const now = this.now();
    const last = this.lastTypingAt.get(threadId);
    if (last !== undefined && now - last < TYPING_REFRESH_MS) {
      return;
    }
    this.lastTypingAt.set(threadId, now);
    await super.startTyping(threadId);
  }

  override async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<WhatsAppRawMessage>> {
    // Sending a message dismisses the typing indicator.
    this.lastTypingAt.delete(threadId);
    return super.postMessage(threadId, message);
  }
}

export function createWhatsAppPlatformAdapter(
  options: WhatsAppPlatformOptions,
): WhatsAppPlatformAdapter {
  return new WhatsAppPlatformAdapter(options);
}
