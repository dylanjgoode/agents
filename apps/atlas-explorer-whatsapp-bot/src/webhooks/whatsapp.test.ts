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

import { readFile } from "node:fs/promises";

import { waitUntil } from "@vercel/functions";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getHttpRuntime } from "../runtime.js";

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("../runtime.js", () => ({
  getHttpRuntime: vi.fn(),
}));

describe("WhatsApp webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("answers Meta's verification handshake", async () => {
    const request = new Request(
      "https://example.com/api/webhooks/whatsapp?hub.mode=subscribe",
    );
    const response = new Response("challenge");
    const webhook = vi.fn().mockResolvedValue(response);
    vi.mocked(getHttpRuntime).mockResolvedValue({
      bot: { webhooks: { whatsapp: webhook } },
    } as never);
    const { GET } = await import("../../api/webhooks/whatsapp.js");

    await expect(GET(request)).resolves.toBe(response);

    expect(webhook).toHaveBeenCalledWith(request);
  });

  it("forwards events with Vercel waitUntil", async () => {
    const request = new Request(
      "https://example.com/api/webhooks/whatsapp",
      { method: "POST", body: "{}" },
    );
    const response = new Response("ok");
    const webhook = vi.fn().mockResolvedValue(response);
    vi.mocked(getHttpRuntime).mockResolvedValue({
      bot: { webhooks: { whatsapp: webhook } },
    } as never);
    const { POST, maxDuration } =
      await import("../../api/webhooks/whatsapp.js");

    await expect(POST(request)).resolves.toBe(response);

    expect(webhook).toHaveBeenCalledWith(request, { waitUntil });
    expect(maxDuration).toBe(300);
  });

  it("keeps API-only Vercel project settings in source control", async () => {
    const vercelConfig = JSON.parse(
      await readFile(
        new URL("../../vercel.json", import.meta.url),
        "utf8",
      ),
    );
    const packageConfig = JSON.parse(
      await readFile(
        new URL("../../package.json", import.meta.url),
        "utf8",
      ),
    );

    expect(vercelConfig).toMatchObject({
      buildCommand: "pnpm --filter @repo/agent-engine-chat build",
      fluid: true,
      framework: null,
      functions: {
        "api/webhooks/whatsapp.ts": { maxDuration: 300 },
      },
    });
    expect(packageConfig.engines.node).toBe("24.x");
  });
});
