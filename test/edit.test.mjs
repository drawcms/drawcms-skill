import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const BIN = join(ROOT, "bin", "drawcms.mjs");

const DOC = {
  schemaVersion: 5,
  meta: { name: "Arch", diagramType: "architecture" },
  canvas: {},
  nodes: [
    {
      id: "api",
      position: { x: 999, y: 777 },
      data: { label: "API", type: "arch-backend" },
      type: "customShape",
      style: { width: 160, height: 112 },
    },
  ],
  edges: [],
  motion: { story: { scenes: [], activeSceneId: null } },
};

async function repo({ doc = DOC, diagrams } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "drawcms-edit-"));
  await mkdir(join(dir, ".drawcms"), { recursive: true });
  await writeFile(
    join(dir, ".drawcms", "config.json"),
    JSON.stringify({
      version: 1,
      origin: "http://localhost:3000",
      teamId: "t",
      projectId: "p",
      diagrams: diagrams ?? { architecture: { id: "d1", type: "architecture", baseVersion: 1 } },
      lastSyncedCommit: null,
    }),
  );
  if (doc) await writeFile(join(dir, ".drawcms", "architecture.json"), JSON.stringify(doc));
  return dir;
}

async function opsFile(operations) {
  const dir = await mkdtemp(join(tmpdir(), "drawcms-ops-"));
  const path = join(dir, "ops.json");
  await writeFile(path, JSON.stringify({ operations }));
  return path;
}

async function cli(args, cwd) {
  try {
    const { stdout } = await execFileAsync("node", [BIN, ...args, "--json"], { cwd });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "" };
  }
}

test("edit applies a batch and preserves a human-moved position", async () => {
  const dir = await repo();
  const ops = await opsFile([
    {
      op: "addNode",
      node: {
        id: "cache",
        position: { x: 400, y: 200 },
        data: { label: "Redis", type: "infra-redis" },
        type: "customShape",
        style: { width: 100, height: 100 },
      },
    },
    { op: "addEdge", edge: { id: "e1", source: "api", target: "cache", data: { label: "cache" } } },
    { op: "updateNode", nodeId: "api", dataPatch: { label: "API Gateway" } },
  ]);
  const { code, stdout } = await cli(["edit", "architecture", ops], dir);
  assert.equal(code, 0, stdout);
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.applied, 3);
  assert.equal(receipt.summary.nodes, 2);

  const doc = JSON.parse(await readFile(join(dir, ".drawcms", "architecture.json"), "utf8"));
  const api = doc.nodes.find((n) => n.id === "api");
  assert.deepEqual(api.position, { x: 999, y: 777 }); // NOT re-laid-out
  assert.equal(api.data.label, "API Gateway");
  assert.ok(doc.nodes.some((n) => n.id === "cache"));
  assert.ok(doc.meta && doc.motion, "meta and motion are preserved");
});

test("edit rejects an operation referencing an unknown node id", async () => {
  const dir = await repo();
  const ops = await opsFile([{ op: "updateNode", nodeId: "ghost", dataPatch: { label: "x" } }]);
  const { code, stdout } = await cli(["edit", "architecture", ops], dir);
  assert.equal(code, 1);
  assert.equal(JSON.parse(stdout).issues[0].code, "UNKNOWN_NODE");
});

test("edit fails when the diagram is not tracked", async () => {
  const dir = await repo();
  const ops = await opsFile([{ op: "deleteNode", nodeId: "api" }]);
  const { code, stdout } = await cli(["edit", "nosuch", ops], dir);
  assert.equal(code, 1);
  assert.equal(JSON.parse(stdout).error.code, "UNKNOWN_DIAGRAM");
});

test("edit fails when there is no local document to edit", async () => {
  const dir = await repo({ doc: null });
  const ops = await opsFile([{ op: "deleteNode", nodeId: "api" }]);
  const { code, stdout } = await cli(["edit", "architecture", ops], dir);
  assert.equal(code, 1);
  assert.equal(JSON.parse(stdout).error.code, "NO_LOCAL_DOCUMENT");
});
