import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { loadSkills } from "./load-skills.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TARGET_SKILLS_DIR = path.resolve(__dirname, "../../skills");

function writeSkillTree(root: string, names: string[]) {
  for (const name of names) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `# ${name}\n`);
  }
}

describe("loadSkills", () => {
  const copies: Array<{ src: string; dest: string }> = [];
  const originalRmSync = fs.rmSync.bind(fs);
  const originalCpSync = fs.cpSync.bind(fs);

  beforeEach(() => {
    copies.length = 0;
    vi.mocked(execFileSync).mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.spyOn(fs, "rmSync").mockImplementation(((
      p: fs.PathLike,
      options?: fs.RmOptions,
    ) => {
      if (path.resolve(String(p)).startsWith(TARGET_SKILLS_DIR)) {
        return undefined;
      }
      return originalRmSync(p, options);
    }) as typeof fs.rmSync);

    vi.spyOn(fs, "cpSync").mockImplementation(((
      src: fs.PathLike,
      dest: fs.PathLike,
      options?: fs.CopyOptions,
    ) => {
      if (path.resolve(String(dest)).startsWith(TARGET_SKILLS_DIR)) {
        copies.push({ src: String(src), dest: String(dest) });
        return undefined;
      }
      return originalCpSync(src, dest, options);
    }) as typeof fs.cpSync);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("clones via git and copies folders that contain SKILL.md", async () => {
    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      if (cmd === "git") {
        const cloneDir = String(args![args!.length - 1]);
        writeSkillTree(path.join(cloneDir, "skills"), [
          "mongodb-connection",
          "mongodb-schema-design",
        ]);
        fs.writeFileSync(path.join(cloneDir, "skills", "README.md"), "skip me");
        return Buffer.from("");
      }
      throw new Error(`unexpected command ${String(cmd)}`);
    });

    const copied = await loadSkills();

    expect(copied.sort()).toEqual([
      "mongodb-connection",
      "mongodb-schema-design",
    ]);
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining([
        "clone",
        "--depth",
        "1",
        "https://github.com/mongodb/agent-skills.git",
      ]),
      expect.objectContaining({ stdio: "pipe" }),
    );
    expect(copies.map((c) => path.basename(c.dest)).sort()).toEqual([
      "mongodb-connection",
      "mongodb-schema-design",
    ]);
  });

  it("falls back to tarball download when git clone fails", async () => {
    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      if (cmd === "git") {
        throw new Error("git: command not found");
      }
      if (cmd === "tar") {
        const dashC = (args as string[]).indexOf("-C");
        const extractDir = (args as string[])[dashC + 1]!;
        writeSkillTree(path.join(extractDir, "agent-skills-main", "skills"), [
          "mongodb-mcp-setup",
        ]);
        return Buffer.from("");
      }
      throw new Error(`unexpected command ${String(cmd)}`);
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(Buffer.from("fake-tar-gz"), { status: 200 })),
    );

    const copied = await loadSkills();

    expect(copied).toEqual(["mongodb-mcp-setup"]);
    expect(fetch).toHaveBeenCalledWith(
      "https://github.com/mongodb/agent-skills/archive/refs/heads/main.tar.gz",
    );
    expect(execFileSync).toHaveBeenCalledWith(
      "tar",
      expect.arrayContaining(["-xzf"]),
      expect.objectContaining({ stdio: "pipe" }),
    );
  });

  it("finds skills/ at the extract root when there is no nested folder", async () => {
    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      if (cmd === "git") {
        throw new Error("clone failed");
      }
      if (cmd === "tar") {
        const dashC = (args as string[]).indexOf("-C");
        const extractDir = (args as string[])[dashC + 1]!;
        writeSkillTree(path.join(extractDir, "skills"), ["direct-skill"]);
        return Buffer.from("");
      }
      throw new Error(`unexpected command ${String(cmd)}`);
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(Buffer.from("fake-tar-gz"), { status: 200 })),
    );

    await expect(loadSkills()).resolves.toEqual(["direct-skill"]);
  });

  it("throws when the tarball download fails", async () => {
    vi.mocked(execFileSync).mockImplementation((cmd) => {
      if (cmd === "git") {
        throw new Error("clone failed");
      }
      throw new Error(`unexpected command ${String(cmd)}`);
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404, statusText: "Not Found" })),
    );

    await expect(loadSkills()).rejects.toThrow(
      /Failed to download tarball: 404 Not Found/,
    );
  });

  it("throws when no SKILL.md folders are present", async () => {
    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      if (cmd === "git") {
        const cloneDir = String(args![args!.length - 1]);
        fs.mkdirSync(path.join(cloneDir, "skills"), { recursive: true });
        fs.writeFileSync(path.join(cloneDir, "skills", "notes.txt"), "not a skill");
        return Buffer.from("");
      }
      throw new Error(`unexpected command ${String(cmd)}`);
    });

    await expect(loadSkills()).rejects.toThrow(/No skills found/);
  });
});
