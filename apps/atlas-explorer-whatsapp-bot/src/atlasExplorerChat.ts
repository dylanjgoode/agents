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

import type { AgentChatMessages } from "@repo/agent-engine-chat/chat";

/**
 * WhatsApp copy for the shared handlers. The review strings never show,
 * because `readOnlyAgent` rejects writes before a review card is built.
 */
export const atlasExplorerChatMessages: Partial<AgentChatMessages> = {
  emptyPrompt:
    "Send me a question as a text message, for example about your MongoDB data.",
};
