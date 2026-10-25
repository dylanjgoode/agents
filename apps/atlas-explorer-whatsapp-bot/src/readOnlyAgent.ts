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

import type { AgentGateway } from "@repo/agent-engine-chat/chat";
import type {
  AgentInterrupt,
  InvocationProgressHandler,
  InvocationResult,
  InvokeInput,
  ReviewDecision,
} from "@repo/agent-engine-chat/agent-engine";

export const READ_ONLY_REJECTION_MESSAGE =
  "Changes can't be made from WhatsApp. Tell the user this channel is " +
  "read-only and that they need to make the change somewhere else.";

// The agent may propose another write after a rejection. Past this many
// rounds the turn fails rather than looping.
const MAX_REJECTION_ROUNDS = 3;

/**
 * Wraps an agent so every write it proposes is rejected without asking.
 *
 * WhatsApp truncates interactive message bodies to 1,024 characters but keeps
 * the buttons, so an approval card could show an Approve button under
 * arguments the user can't fully see. This bot therefore never shows review
 * cards: when the agent pauses for approval, the wrapper resumes it with a
 * rejection and returns the agent's next reply instead.
 */
export function readOnlyAgent(agent: AgentGateway): AgentGateway {
  async function rejectWrites(
    input: InvokeInput,
    result: InvocationResult,
    onProgress?: InvocationProgressHandler,
  ): Promise<InvocationResult> {
    for (
      let round = 0;
      result.kind === "suspended" && round < MAX_REJECTION_ROUNDS;
      round += 1
    ) {
      const [first, ...rest] = result.interrupts;
      result = await agent.resumeStream(
        {
          sessionId: result.sessionId,
          interruptId: first!.id,
          decision: rejections(first!),
          additionalInterrupts: rest.map((interrupt) => ({
            interruptId: interrupt.id,
            decision: rejections(interrupt),
          })),
          actorId: input.actorId,
          ...(input.client !== undefined ? { client: input.client } : {}),
          ...(input.user !== undefined ? { user: input.user } : {}),
        },
        onProgress,
      );
    }
    if (result.kind === "suspended") {
      throw new Error(
        `Agent kept proposing writes after ${MAX_REJECTION_ROUNDS} rejections`,
      );
    }
    return result;
  }

  return {
    async invoke(input) {
      return rejectWrites(input, await agent.invoke(input));
    },
    async invokeStream(input, onProgress) {
      return rejectWrites(
        input,
        await agent.invokeStream(input, onProgress),
        onProgress,
      );
    },
    resume: (input) => agent.resume(input),
    resumeStream: (input, onProgress) =>
      agent.resumeStream(input, onProgress),
  };
}

function rejections(interrupt: AgentInterrupt): ReviewDecision[] {
  return interrupt.actionRequests.map(() => ({
    type: "reject",
    message: READ_ONLY_REJECTION_MESSAGE,
  }));
}
