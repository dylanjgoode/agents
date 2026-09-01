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

  it("routes every mutative Atlas Streams tool through runtime approval", () => {
    const streamsSkillRoot = path.join(
      skillsRoot,
      "mongodb-atlas-stream-processing",
    );
    const skillContent = fs.readFileSync(
      path.join(streamsSkillRoot, "SKILL.md"),
      "utf8",
    );
    const troubleshootingContent = fs.readFileSync(
      path.join(streamsSkillRoot, "references", "mcp-troubleshooting.md"),
      "utf8",
    );
    const workflowContent = fs.readFileSync(
      path.join(streamsSkillRoot, "references", "development-workflow.md"),
      "utf8",
    );

    expect(skillContent).toContain(
      "`mongodb__atlas_streams_build`, `mongodb__atlas_streams_manage`, and `mongodb__atlas_streams_teardown` are protected by Magenta's runtime approval interrupt",
    );
    expect(skillContent).toContain(
      "call the mutative tool directly and let runtime approval suspend it",
    );
    expect(skillContent).not.toContain(
      "Wait for confirmation before calling `mongodb__atlas_streams_teardown`",
    );
    expect(skillContent).not.toContain("before requesting confirmation");
    expect(troubleshootingContent).toContain(
      "The build, manage, and teardown tools remain subject to Magenta's runtime approval interrupt.",
    );
    expect(workflowContent).toContain(
      "Call `mongodb__atlas_streams_build` directly after the validation summary.",
    );
    expect(workflowContent).not.toContain("Wait for user confirmation");
    expect(workflowContent).not.toContain(
      "ask the user to confirm before proceeding",
    );
  });
});
