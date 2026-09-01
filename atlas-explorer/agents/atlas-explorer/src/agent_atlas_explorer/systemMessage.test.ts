import { describe, expect, it } from "vitest";

import { SYSTEM_PROMPT } from "./systemMessage.js";

describe("SYSTEM_PROMPT", () => {
  it("identifies Atlas Explorer and requires approval for database mutations", () => {
    expect(SYSTEM_PROMPT).toContain("You are Atlas Explorer");
    expect(SYSTEM_PROMPT).toContain("confirm before making database changes");
    expect(SYSTEM_PROMPT).toContain(
      "runtime enforces approval for every mutative database tool",
    );
    expect(SYSTEM_PROMPT).toContain(
      "Never use $out or $merge in mongodb__aggregate",
    );
    expect(SYSTEM_PROMPT).toContain("read-only exploration");
  });

  it("does not retain the insurance-template persona", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/SecureLife|insurance|claims/i);
  });
});
