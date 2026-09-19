// Thin git helpers. All degrade gracefully outside a git repo (return null)
// rather than throwing, so commands can work on a plain directory too.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(args, cwd = process.cwd()) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** True when cwd is inside a git work tree. */
export async function isGitRepo(cwd = process.cwd()) {
  return (await git(["rev-parse", "--is-inside-work-tree"], cwd)) === "true";
}

/** Current HEAD commit sha, or null. */
export async function headCommit(cwd = process.cwd()) {
  return git(["rev-parse", "HEAD"], cwd);
}

/** A short human label for the repo (basename of the toplevel), or null. */
export async function repoName(cwd = process.cwd()) {
  const top = await git(["rev-parse", "--show-toplevel"], cwd);
  if (!top) return null;
  return top.split("/").filter(Boolean).pop() ?? null;
}

/**
 * A repo/project label that always resolves to *something* representing the
 * directory: the git toplevel basename when in a repo, otherwise the plain
 * working-directory basename. Used to name the DrawCMS project after the
 * repo/project rather than a generic placeholder.
 */
export async function projectLabel(cwd = process.cwd()) {
  const fromGit = await repoName(cwd);
  if (fromGit) return fromGit;
  return cwd.split("/").filter(Boolean).pop() ?? null;
}

/** `git diff <from>..HEAD --stat`, or null if unavailable. */
export async function diffStatSince(from, cwd = process.cwd()) {
  if (!from) return null;
  return git(["diff", `${from}..HEAD`, "--stat"], cwd);
}

/** List of files changed between `from` and HEAD, or null. */
export async function changedFilesSince(from, cwd = process.cwd()) {
  if (!from) return null;
  const out = await git(["diff", `${from}..HEAD`, "--name-only"], cwd);
  if (out === null) return null;
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}
