import { waitUntil } from "@vercel/functions";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getHttpRuntime } from "../../src/runtime.js";

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("../../src/runtime.js", () => ({
  getHttpRuntime: vi.fn(),
}));

describe("Slack webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards the untouched request and Vercel waitUntil", async () => {
    const request = new Request(
      "https://example.com/api/webhooks/slack",
      {
        method: "POST",
        body: JSON.stringify({ type: "url_verification" }),
      },
    );
    const response = new Response("ok");
    const webhook = vi.fn().mockResolvedValue(response);
    vi.mocked(getHttpRuntime).mockResolvedValue({
      bot: {
        webhooks: { slack: webhook },
      },
    } as never);
    const { POST, maxDuration } = await import("./slack.js");

    await expect(POST(request)).resolves.toBe(response);

    expect(webhook).toHaveBeenCalledWith(request, { waitUntil });
    expect(maxDuration).toBe(300);
  });
});
