import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Prefer the repo-root draft so prompt edits in `docs/` are picked up in
 * development. Fall back to the vendored copy shipped with this package.
 */
const PROMPT_CANDIDATES = [
  path.resolve(__dirname, "../../../docs/sys-prompt-draft.md"),
  path.resolve(__dirname, "prompt.md"),
];

export function loadSystemPrompt(): string {
  for (const candidate of PROMPT_CANDIDATES) {
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, "utf8").trim();
    }
  }

  throw new Error(
    `System prompt not found. Tried:\n${PROMPT_CANDIDATES.join("\n")}`,
  );
}

export const SYSTEM_PROMPT = loadSystemPrompt();
