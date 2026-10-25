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

import { describe, expect, it } from "vitest";

import {
  FakeAgentGateway,
  completed,
  suspended,
} from "@repo/agent-engine-chat/testing";
import type { InvokeInput } from "@repo/agent-engine-chat/agent-engine";

import {
  READ_ONLY_REJECTION_MESSAGE,
  readOnlyAgent,
} from "./readOnlyAgent.js";

const input: InvokeInput = {
  message: "Drop the empty collections",
  actorId: "whatsapp:15550001111",
  client: "whatsapp",
  user: { id: "15550001111", actor_id: "whatsapp:15550001111" },
};

const rejection = {
  type: "reject",
  message: READ_ONLY_REJECTION_MESSAGE,
} as const;

describe("readOnlyAgent", () => {
  it("passes completed answers through untouched", async () => {
    const agent = new FakeAgentGateway();
    agent.invokeResult = completed;

    await expect(readOnlyAgent(agent).invokeStream(input)).resolves.toBe(
      completed,
    );
    expect(agent.resumeInputs).toEqual([]);
  });

  it("rejects every proposed write and returns the agent's reply", async () => {
    const agent = new FakeAgentGateway();
    agent.invokeResult = {
      ...suspended,
      interrupts: [
        suspended.interrupts[0]!,
        {
          id: "interrupt-2",
          actionRequests: [
            { name: "mongodb__delete_many", args: {} },
            { name: "mongodb__drop_collection", args: {} },
          ],
        },
      ],
    };
    agent.resumeResult = completed;
    const progress: string[] = [];

    const result = await readOnlyAgent(agent).invokeStream(
      input,
      (update) => {
        progress.push(update.content);
      },
    );

    expect(result).toBe(completed);
    expect(agent.resumeInputs).toEqual([
      {
        sessionId: "session-1",
        interruptId: "interrupt-1",
        decision: [rejection],
        additionalInterrupts: [
          {
            interruptId: "interrupt-2",
            decision: [rejection, rejection],
          },
        ],
        actorId: input.actorId,
        client: input.client,
        user: input.user,
      },
    ]);
  });

  it("forwards progress from the resumed run", async () => {
    const agent = new FakeAgentGateway();
    agent.invokeResult = suspended;
    agent.resumeResult = completed;
    agent.progressEvents = [{ content: "Thinking" }];
    const progress: string[] = [];

    await readOnlyAgent(agent).invokeStream(input, (update) => {
      progress.push(update.content);
    });

    // Once for the first run and once for the resumed run.
    expect(progress).toEqual(["Thinking", "Thinking"]);
  });

  it("gives up when the agent keeps proposing writes", async () => {
    const agent = new FakeAgentGateway();
    agent.invokeResult = suspended;
    agent.resumeResult = suspended;

    await expect(readOnlyAgent(agent).invokeStream(input)).rejects.toThrow(
      "Agent kept proposing writes after 3 rejections",
    );
    expect(agent.resumeInputs).toHaveLength(3);
  });

  it("also rejects writes on the non-streaming path", async () => {
    const agent = new FakeAgentGateway();
    agent.invokeResult = suspended;
    agent.resumeResult = completed;

    await expect(readOnlyAgent(agent).invoke(input)).resolves.toBe(
      completed,
    );
    expect(agent.resumeInputs).toHaveLength(1);
  });
});
