import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadSystemPrompt, SYSTEM_PROMPT } from "./prompt.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROMPT_CANDIDATES = [
  path.resolve(__dirname, "../../../docs/sys-prompt-draft.md"),
  path.resolve(__dirname, "prompt.md"),
];

describe("system prompt", () => {
  it("loads a non-empty DeepAtlas prompt from disk", () => {
    const prompt = loadSystemPrompt();

    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("DeepAtlas");
    expect(prompt).toBe(prompt.trim());
    expect(SYSTEM_PROMPT).toBe(prompt);
  });

  it("prefers the first existing candidate on disk", () => {
    const expectedPath = PROMPT_CANDIDATES.find((candidate) =>
      fs.existsSync(candidate),
    );
    expect(expectedPath).toBeDefined();

    const expected = fs.readFileSync(expectedPath!, "utf8").trim();
    expect(loadSystemPrompt()).toBe(expected);
  });

  it("ships a vendored prompt.md fallback", () => {
    const vendored = path.resolve(__dirname, "prompt.md");
    expect(fs.existsSync(vendored)).toBe(true);
    expect(fs.readFileSync(vendored, "utf8")).toContain("DeepAtlas");
  });
});
