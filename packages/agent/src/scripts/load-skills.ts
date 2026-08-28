import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TARGET_SKILLS_DIR = path.resolve(__dirname, "../../skills");
const REPO_URL = "https://github.com/mongodb/agent-skills.git";
const TARBALL_URL =
  "https://github.com/mongodb/agent-skills/archive/refs/heads/main.tar.gz";

function createTempDir(): string {
  try {
    return fs.mkdtempSync(path.join(os.tmpdir(), "mongodb-agent-skills-"));
  } catch {
    const localTmp = path.resolve(__dirname, "../../.tmp-skills");
    fs.mkdirSync(localTmp, { recursive: true });
    return fs.mkdtempSync(path.join(localTmp, "repo-"));
  }
}

async function fetchRepo(tempDir: string): Promise<string> {
  // Attempt 1: git clone --depth 1
  try {
    console.log(`Attempting git clone from ${REPO_URL}...`);
    const cloneDir = path.join(tempDir, "clone");
    execFileSync("git", ["clone", "--depth", "1", REPO_URL, cloneDir], {
      stdio: "pipe",
    });
    const skillsDir = path.join(cloneDir, "skills");
    if (fs.existsSync(skillsDir) && fs.statSync(skillsDir).isDirectory()) {
      return skillsDir;
    }
  } catch (gitErr) {
    const message = gitErr instanceof Error ? gitErr.message : String(gitErr);
    console.warn(
      `Git clone was unavailable or failed (${message}). Falling back to tarball archive download...`,
    );
  }

  // Attempt 2: download tarball archive and extract
  console.log(`Downloading tarball archive from ${TARBALL_URL}...`);
  const tarballPath = path.join(tempDir, "archive.tar.gz");
  const extractDir = path.join(tempDir, "extracted");
  fs.mkdirSync(extractDir, { recursive: true });

  const response = await fetch(TARBALL_URL);
  if (!response.ok) {
    throw new Error(
      `Failed to download tarball: ${response.status} ${response.statusText}`,
    );
  }

  if (!response.body) {
    throw new Error("Response body is empty when fetching tarball");
  }

  const nodeStream = Readable.fromWeb(
    response.body as Parameters<typeof Readable.fromWeb>[0],
  );
  const fileStream = fs.createWriteStream(tarballPath);
  await pipeline(nodeStream, fileStream);

  console.log("Extracting archive...");
  execFileSync("tar", ["-xzf", tarballPath, "-C", extractDir], {
    stdio: "pipe",
  });

  // Locate skills/ directory inside extracted folder (e.g. agent-skills-main/skills)
  const subdirs = fs.readdirSync(extractDir);
  for (const subdir of subdirs) {
    const candidate = path.join(extractDir, subdir, "skills");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }

  const directCandidate = path.join(extractDir, "skills");
  if (
    fs.existsSync(directCandidate) &&
    fs.statSync(directCandidate).isDirectory()
  ) {
    return directCandidate;
  }

  throw new Error(
    `Could not find "skills" directory in extracted repository archive`,
  );
}

export async function loadSkills(): Promise<string[]> {
  console.log("Starting skills download from mongodb/agent-skills...");
  const tempDir = createTempDir();
  try {
    const sourceSkillsDir = await fetchRepo(tempDir);
    fs.mkdirSync(TARGET_SKILLS_DIR, { recursive: true });

    const entries = fs.readdirSync(sourceSkillsDir, { withFileTypes: true });
    const skillFolders = entries.filter((entry) => {
      if (!entry.isDirectory()) return false;
      const skillPath = path.join(sourceSkillsDir, entry.name);
      const skillMd = path.join(skillPath, "SKILL.md");
      return fs.existsSync(skillMd);
    });

    if (skillFolders.length === 0) {
      throw new Error(`No skills found in ${sourceSkillsDir}`);
    }

    console.log(`Found ${skillFolders.length} skills in repository:\n`);

    const copiedSkills: string[] = [];
    for (const folder of skillFolders) {
      const srcPath = path.join(sourceSkillsDir, folder.name);
      const destPath = path.join(TARGET_SKILLS_DIR, folder.name);

      if (fs.existsSync(destPath)) {
        fs.rmSync(destPath, { recursive: true, force: true });
      }

      fs.cpSync(srcPath, destPath, { recursive: true });
      copiedSkills.push(folder.name);
      console.log(`  ✓ Vendored skill: ${folder.name}`);
    }

    const relPath =
      path.relative(process.cwd(), TARGET_SKILLS_DIR) || TARGET_SKILLS_DIR;
    console.log(
      `\nSuccessfully vendored ${copiedSkills.length} skills into ${relPath}`,
    );
    return copiedSkills;
  } finally {
    console.log("Cleaning up temporary directories...");
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      const message =
        cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      console.warn(
        `Warning: Failed to clean up temp dir ${tempDir}: ${message}`,
      );
    }
  }
}

// Execute when run directly as a script
const isDirectExecution =
  process.argv[1] &&
  (path.resolve(process.argv[1]) === path.resolve(__filename) ||
    process.argv[1].endsWith("load-skills.ts") ||
    process.argv[1].endsWith("load-skills.js"));

if (isDirectExecution) {
  loadSkills().catch((err) => {
    console.error("Error loading skills:", err);
    process.exitCode = 1;
  });
}
