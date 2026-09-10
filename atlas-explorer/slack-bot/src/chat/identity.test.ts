import { describe, expect, it } from "vitest";

import {
  platformActorId,
  platformFromThreadId,
} from "./identity.js";

describe("chat identity normalization", () => {
  it("qualifies actors by adapter", () => {
    expect(platformActorId("slack", "U123")).toBe("slack:U123");
    expect(platformActorId("discord", "123")).toBe("discord:123");
  });

  it("reads the adapter namespace from a Chat SDK thread ID", () => {
    expect(platformFromThreadId("slack:C123:1234.5")).toBe("slack");
    expect(platformFromThreadId("invalid")).toBeNull();
  });
});
