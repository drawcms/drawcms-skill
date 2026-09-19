import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const BIN = join(ROOT, "bin", "drawcms.mjs");

const doc = { meta: { name: "Arch", diagramType: "architecture" }, nodes: [], edges: [] };
const docText = JSON.stringify(doc, null, 2) + "\n";
const docHash = createHash("sha256").update(docText).digest("hex");

async function gitRepo() {
  const repo = await mkdtemp(join(tmpdir(), "drawcms-status-"));
  await execFileAsync("git", ["init", "-q"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "t@e.com"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "T"], { cwd: repo });
  return repo;
}

async function commit(repo, file, content) {
  await writeFile(join(repo, file), content);
  await execFileAsync("git", ["add", "."], { cwd: repo });
  await execFileAsync("git", ["commit", "-q", "-m", `add ${file}`], { cwd: repo });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo });
  return stdout.trim();
}

async function writeLink(repo, { lastSyncedCommit = null, pulledHash = docHash } = {}) {
  await mkdir(join(repo, ".drawcms"), { recursive: true });
  await writeFile(
    join(repo, ".drawcms", "config.json"),
    JSON.stringify({
      version: 1,
      origin: "https://drawcms.com",
      teamId: "t1",
      teamName: "Team",
      projectId: "p1",
      projectName: "Proj",
      diagrams: { architecture: { id: "d1", type: "architecture", baseVersion: 2, pulledHash } },
      lastSyncedCommit,
    }),
  );
  await writeFile(join(repo, ".drawcms", "architecture.json"), docText);
}

async function cli(cmd, repo) {
  try {
    const { stdout } = await execFileAsync("node", [BIN, cmd, "--json"], { cwd: repo });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "" };
  }
}

test("status reports not-linked outside an initialized repo", async () => {
  const repo = await mkdtemp(join(tmpdir(), "drawcms-status-"));
  const { code, stdout } = await cli("status", repo);
  assert.equal(code, 0);
  const r = JSON.parse(stdout);
  assert.equal(r.linked, false);
});

test("status reports a clean diagram and diagrams-at-HEAD", async () => {
  const repo = await gitRepo();
  const head = await commit(repo, "README.md", "# x\n");
  await writeLink(repo, { lastSyncedCommit: head });
  const { code, stdout } = await cli("status", repo);
  assert.equal(code, 0);
  const r = JSON.parse(stdout);
  assert.equal(r.linked, true);
  assert.equal(r.git.behind, false);
  assert.equal(r.diagrams[0].local, "clean");
});

test("status flags a locally modified diagram and commit drift", async () => {
  const repo = await gitRepo();
  const first = await commit(repo, "README.md", "# x\n");
  await writeLink(repo, { lastSyncedCommit: first });
  // Advance HEAD past the synced commit.
  await commit(repo, "src.js", "console.log(1)\n");
  // Edit the local diagram so its hash no longer matches pulledHash.
  await writeFile(join(repo, ".drawcms", "architecture.json"), docText + "// edited\n");

  const { stdout } = await cli("status", repo);
  const r = JSON.parse(stdout);
  assert.equal(r.git.behind, true);
  assert.equal(r.diagrams[0].local, "modified");
});

test("diff shows the code range and locally modified diagrams", async () => {
  const repo = await gitRepo();
  const first = await commit(repo, "README.md", "# x\n");
  await writeLink(repo, { lastSyncedCommit: first });
  await commit(repo, "src.js", "console.log(1)\n");
  await writeFile(join(repo, ".drawcms", "architecture.json"), docText + "// edited\n");

  const { code, stdout } = await cli("diff", repo);
  assert.equal(code, 0);
  const r = JSON.parse(stdout);
  assert.ok(r.git.range, "should have a commit range");
  assert.ok(r.git.changedFiles.includes("src.js"));
  assert.deepEqual(
    r.diagrams.filter((d) => d.modified).map((d) => d.name),
    ["architecture"],
  );
});

test("diff fails when not initialized", async () => {
  const repo = await mkdtemp(join(tmpdir(), "drawcms-status-"));
  const { code, stdout } = await cli("diff", repo);
  assert.equal(code, 1);
  assert.equal(JSON.parse(stdout).error.code, "NOT_INITIALIZED");
});
