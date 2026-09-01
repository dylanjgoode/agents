import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const agentRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const skillsRoot = path.join(agentRoot, "skills");

const EXPECTED_SKILLS = [
  "mongodb-atlas-stream-processing",
  "mongodb-connection",
  "mongodb-mcp-setup",
  "mongodb-natural-language-querying",
  "mongodb-query-optimizer",
  "mongodb-schema-design",
  "mongodb-search-and-ai",
];

function markdownFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".md") ? [entryPath] : [];
  });
}

describe("MongoDB skills bundle", () => {
  it("ships every source-agent skill with discoverable frontmatter", () => {
    const skillDirectories = fs
      .readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(skillDirectories).toEqual(EXPECTED_SKILLS);
    for (const directory of skillDirectories) {
      const content = fs.readFileSync(
        path.join(skillsRoot, directory, "SKILL.md"),
        "utf8",
      );
      expect(content, `${directory} is missing a skill name`).toMatch(
        /^---[\s\S]*^name:\s*\S+/m,
      );
      expect(content, `${directory} is missing a description`).toMatch(
        /^---[\s\S]*^description:\s*\S+/m,
      );
    }

    const allSkillMarkdown = markdownFiles(skillsRoot)
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");
    expect(allSkillMarkdown).not.toMatch(
      /mcp__mongodb__|MDB_MCP_|atlas-local-(?:create|list)-deployment|apiClientId|apiClientSecret|Install the MongoDB MCP Server/,
    );
    expect(allSkillMarkdown).toContain("mongodb__collection_indexes");
    expect(allSkillMarkdown).toContain("mongodb__atlas_streams_teardown");
    expect(allSkillMarkdown).toContain("ATLAS_PRIVATE_API_KEY");
  });
});
