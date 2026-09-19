import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const BIN = join(ROOT, "bin", "drawcms.mjs");

const DIAGRAM_ID = "diag-1";

// The local working copy the repo has on disk.
const localDoc = {
  meta: { name: "Arch", diagramType: "architecture" },
  nodes: [
    { id: "a", data: { label: "Browser" }, position: { x: 0, y: 0 } },
    { id: "b", data: { label: "API" }, position: { x: 0, y: 100 } },
  ],
  edges: [{ id: "e1", source: "a", target: "b", label: "HTTPS" }],
};

async function withServer(cloudDoc, run, { version = 6 } = {}) {
  const server = createServer((req, res) => {
    const json = (status, obj) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const authed = (req.headers.authorization || "").startsWith("Bearer ");
    if (!authed) return json(401, { ok: false, error: { code: "AUTH_REQUIRED", message: "no" } });
    if (req.url === `/api/diagrams/${DIAGRAM_ID}/document` && req.method === "GET") {
      return json(200, { ok: true, version, document: cloudDoc });
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

async function setup(origin, { baseVersion = 6 } = {}) {
  const configHome = await mkdtemp(join(tmpdir(), "drawcms-diffc-home-"));
  const repo = await mkdtemp(join(tmpdir(), "drawcms-diffc-repo-"));
  await writeFile(join(configHome, "config.json"), JSON.stringify({ token: "tok" }));
  await mkdir(join(repo, ".drawcms"), { recursive: true });
  await writeFile(
    join(repo, ".drawcms", "config.json"),
    JSON.stringify({
      version: 1,
      origin,
      teamId: "team-1",
      projectId: "proj-1",
      diagrams: { architecture: { id: DIAGRAM_ID, type: "architecture", baseVersion } },
      lastSyncedCommit: null,
    }),
  );
  await writeFile(join(repo, ".drawcms", "architecture.json"), JSON.stringify(localDoc, null, 2) + "\n");
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

test("diff --against-cloud reports identical when local matches cloud", async () => {
  await withServer(localDoc, async (origin) => {
    const { configHome, repo } = await setup(origin);
    const { code, stdout } = await cli(["diff", "--against-cloud"], { configHome, repo, origin });
    assert.equal(code, 0, stdout);
    const d = JSON.parse(stdout).diagrams.find((x) => x.name === "architecture");
    assert.equal(d.cloud.status, "identical");
  });
});

test("diff --against-cloud reports a node/edge delta when diverged", async () => {
  const cloudDoc = {
    meta: { name: "Arch", diagramType: "architecture" },
    nodes: [
      { id: "a", data: { label: "Browser" }, position: { x: 50, y: 50 } }, // moved (layout only)
      { id: "b", data: { label: "Gateway" }, position: { x: 0, y: 100 } }, // relabeled
      { id: "c", data: { label: "DB" }, position: { x: 0, y: 200 } }, // added on cloud
    ],
    edges: [{ id: "e1", source: "a", target: "b", label: "HTTPS" }],
  };
  await withServer(cloudDoc, async (origin) => {
    const { configHome, repo } = await setup(origin);
    const { code, stdout } = await cli(["diff", "--against-cloud"], { configHome, repo, origin });
    assert.equal(code, 0, stdout);
    const c = JSON.parse(stdout).diagrams.find((x) => x.name === "architecture").cloud;
    assert.equal(c.status, "diverged");
    assert.equal(c.delta.counts.nodesAdded, 1);
    assert.equal(c.delta.counts.nodePositionMoves, 1);
    assert.equal(c.delta.counts.nodesChanged, 1);
  });
});

test("diff --against-cloud flags when the cloud moved past baseVersion (push would conflict)", async () => {
  const cloudDoc = { ...localDoc, nodes: [...localDoc.nodes, { id: "x", data: { label: "New" } }] };
  await withServer(cloudDoc, async (origin) => {
    // Local baseVersion is behind the server version (6).
    const { configHome, repo } = await setup(origin, { baseVersion: 4 });
    const { stdout } = await cli(["diff", "--against-cloud"], { configHome, repo, origin });
    const c = JSON.parse(stdout).diagrams.find((x) => x.name === "architecture").cloud;
    assert.equal(c.behindServer, true);
  });
});

test("plain diff makes no network call and omits the cloud section", async () => {
  await withServer(localDoc, async (origin) => {
    const { configHome, repo } = await setup(origin);
    const { code, stdout } = await cli(["diff"], { configHome, repo, origin });
    assert.equal(code, 0, stdout);
    const d = JSON.parse(stdout).diagrams.find((x) => x.name === "architecture");
    assert.equal(d.cloud, undefined);
  });
});
