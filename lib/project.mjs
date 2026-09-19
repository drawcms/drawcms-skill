// Per-repo project link, stored at <repo>/.drawcms/config.json. This binds the
// working directory to a specific DrawCMS workspace + project and tracks the
// diagrams the repo owns and the commit each was last synced from. It is
// intentionally separate from the global ~/.drawcms/config.json (auth token +
// default origin): one login serves every repo, but each repo points at its own
// project.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const PROJECT_DIR = ".drawcms";
export const PROJECT_FILE = "config.json";

export function projectConfigPath(cwd = process.cwd()) {
  return join(cwd, PROJECT_DIR, PROJECT_FILE);
}

/** Read the repo link, or null when the repo has not been `drawcms init`ed. */
export async function readProjectConfig(cwd = process.cwd()) {
  const path = projectConfigPath(cwd);
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    // Name the file and the remedy: a raw JSON parse error here is
    // unactionable, and this file is hand-editable by design.
    const failure = new Error(
      `${path} is not valid JSON. Fix it, or delete the .drawcms directory and run \`drawcms init\` again.`,
    );
    failure.code = "PROJECT_CONFIG_CORRUPT";
    throw failure;
  }
}

/** Write the repo link. Not secret (no token here), so default perms are fine. */
export async function writeProjectConfig(config, cwd = process.cwd()) {
  const path = projectConfigPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2) + "\n");
  return path;
}

/**
 * Ensure `<repo>/.drawcms/.gitignore` excludes local-only artifacts from source
 * control: the `push --force` stash snapshots (`*.stash.json`). The tracked
 * config and document files are intentionally committable (they let the repo
 * regenerate its diagrams), but a stash is a throwaway recovery copy of a cloud
 * revision and must never be checked in. Idempotent: only writes when absent.
 */
export async function ensureProjectGitignore(cwd = process.cwd()) {
  const path = join(cwd, PROJECT_DIR, ".gitignore");
  const body = [
    "# Local-only DrawCMS artifacts — do not commit.",
    "# Recovery snapshots written by `drawcms push --force`.",
    "*.stash.json",
    "",
  ].join("\n");
  try {
    await readFile(path, "utf8");
    return null; // already present; leave any user edits alone
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
  return path;
}

/**
 * The canonical shape of the repo link.
 * {
 *   version: 1,
 *   origin: "https://drawcms.com",
 *   teamId, teamName,
 *   projectId, projectName,
 *   diagrams: { "<logical name>": { id, type, baseVersion } },
 *   lastSyncedCommit: "<sha>" | null
 * }
 */
export function emptyProjectConfig({ origin, teamId, teamName, projectId, projectName }) {
  return {
    version: 1,
    origin,
    teamId,
    teamName: teamName ?? null,
    projectId,
    projectName: projectName ?? null,
    diagrams: {},
    lastSyncedCommit: null,
  };
}
