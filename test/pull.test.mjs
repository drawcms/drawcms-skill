import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const BIN = join(ROOT, "bin", "drawcms.mjs");

const DIAGRAM_ID = "diag-1";
const serverDoc = { meta: { name: "Arch", diagramType: "architecture" }, nodes: [], edges: [] };

async function withServer(run, { version = 3 } = {}) {
  const server = createServer((req, res) => {
    const json = (status, obj) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const authed = (req.headers.authorization || "").startsWith("Bearer ");
    if (!authed) return json(401, { ok: false, error: { code: "AUTH_REQUIRED", message: "no" } });
    if (req.url === `/api/diagrams/${DIAGRAM_ID}/document` && req.method === "GET") {
      return json(200, { ok: true, document: serverDoc, version });
    }
    json(404, { ok: false, error: { code: "NOT_FOUND", message: "x" } });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

async function setup(origin, { diagrams } = {}) {
  const configHome = await mkdtemp(join(tmpdir(), "drawcms-pull-home-"));
  const repo = await mkdtemp(join(tmpdir(), "drawcms-pull-repo-"));
  await writeFile(join(configHome, "config.json"), JSON.stringify({ token: "tok" }));
  await mkdir(join(repo, ".drawcms"), { recursive: true });
  await writeFile(
    join(repo, ".drawcms", "config.json"),
    JSON.stringify({
      version: 1,
      origin,
      teamId: "team-1",
      projectId: "proj-1",
      diagrams: diagrams ?? { architecture: { id: DIAGRAM_ID, type: "architecture", baseVersion: null } },
      lastSyncedCommit: null,
    }),
  );
  return { configHome, repo };
}

async function cli(args, { configHome, repo, origin }) {
  try {
    const { stdout } = await execFileAsync("node", [BIN, ...args, "--origin", origin, "--json"], {
      cwd: repo,
      env: { ...process.env, DRAWCMS_CONFIG_HOME: configHome, DRAWCMS_NO_BROWSER: "1" },
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "" };
  }
}

test("pull writes the document and records the server version", async () => {
  await withServer(async (origin) => {
    const { configHome, repo } = await setup(origin);
    const { code, stdout } = await cli(["pull"], { configHome, repo, origin });
    assert.equal(code, 0, stdout);
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.results[0].status, "pulled");
    assert.equal(receipt.results[0].version, 3);

    const doc = JSON.parse(await readFile(join(repo, ".drawcms", "architecture.json"), "utf8"));
    assert.equal(doc.meta.diagramType, "architecture");

    const link = JSON.parse(await readFile(join(repo, ".drawcms", "config.json"), "utf8"));
    assert.equal(link.diagrams.architecture.baseVersion, 3);
    assert.ok(link.diagrams.architecture.pulledHash, "should record a pulledHash");
  });
});

test("pull skips a locally edited working copy without --force, and overwrites with it", async () => {
  await withServer(async (origin) => {
    const { configHome, repo } = await setup(origin);
    // First pull establishes pulledHash.
    await cli(["pull"], { configHome, repo, origin });
    // Simulate a local edit.
    const docPath = join(repo, ".drawcms", "architecture.json");
    await writeFile(docPath, JSON.stringify({ meta: { diagramType: "architecture" }, nodes: [{ id: "x" }], edges: [] }, null, 2) + "\n");

    const skipped = await cli(["pull"], { configHome, repo, origin });
    assert.equal(skipped.code, 0);
    assert.equal(JSON.parse(skipped.stdout).results[0].status, "skipped");
    // Local edit preserved.
    const stillEdited = JSON.parse(await readFile(docPath, "utf8"));
    assert.equal(stillEdited.nodes.length, 1);

    const forced = await cli(["pull", "--force"], { configHome, repo, origin });
    assert.equal(JSON.parse(forced.stdout).results[0].status, "pulled");
    const overwritten = JSON.parse(await readFile(docPath, "utf8"));
    assert.equal(overwritten.nodes.length, 0);
  });
});

test("pull fails when not initialized", async () => {
  await withServer(async (origin) => {
    const configHome = await mkdtemp(join(tmpdir(), "drawcms-pull-home-"));
    const repo = await mkdtemp(join(tmpdir(), "drawcms-pull-repo-"));
    await writeFile(join(configHome, "config.json"), JSON.stringify({ token: "tok" }));
    const { code, stdout } = await cli(["pull"], { configHome, repo, origin });
    assert.equal(code, 1);
    assert.equal(JSON.parse(stdout).error.code, "NOT_INITIALIZED");
  });
});
