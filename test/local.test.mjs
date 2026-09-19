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

const validSpec = {
  name: "Demo architecture",
  diagramType: "architecture",
  nodes: [
    { id: "web", label: "Web app", type: "arch-frontend" },
    { id: "api", label: "API", type: "arch-backend" },
  ],
  edges: [{ source: "web", target: "api", label: "HTTPS" }],
};

async function run(args, cwd) {
  try {
    const { stdout } = await execFileAsync("node", [BIN, ...args, "--json"], {
      cwd,
      env: { ...process.env, DRAWCMS_NO_BROWSER: "1" },
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "" };
  }
}

test("local builds a self-hosted document from a spec file and writes it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drawcms-local-"));
  const specPath = join(dir, "arch.json");
  await writeFile(specPath, JSON.stringify(validSpec));

  const { code, stdout } = await run(["local", "architecture", specPath], dir);
  assert.equal(code, 0, stdout);
  const r = JSON.parse(stdout);
  assert.equal(r.ok, true);
  assert.equal(r.mode, "self-hosted");
  assert.equal(r.out, join(dir, "arch.built.json"));
  // The written file is a real built DrawCMSDocument (has schemaVersion + meta).
  const doc = JSON.parse(await readFile(r.out, "utf8"));
  assert.equal(doc.schemaVersion, 5);
  assert.equal(doc.meta.name, "Demo architecture");
  assert.equal(doc.nodes.length, 2);
});

test("local --seed emits a localStorage snippet for the OSS storage key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drawcms-local-"));
  const specPath = join(dir, "arch.json");
  await writeFile(specPath, JSON.stringify(validSpec));

  const { code, stdout } = await run(["local", "architecture", specPath, "--seed"], dir);
  assert.equal(code, 0, stdout);
  const r = JSON.parse(stdout);
  assert.ok(r.seedSnippet.includes("drawcms.document.v1"), "seed must target the OSS storage key");
  assert.ok(r.seedSnippet.includes("location.reload()"), "seed should reload to apply");
  // The seed embeds the same document that was written.
  assert.ok(r.seedSnippet.includes('\\"schemaVersion\\":5'));
});

test("local resolves a tracked diagram name from .drawcms/", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drawcms-local-"));
  await mkdir(join(dir, ".drawcms"), { recursive: true });
  await writeFile(
    join(dir, ".drawcms", "config.json"),
    JSON.stringify({
      version: 1,
      origin: "http://localhost:3000",
      teamId: "t",
      projectId: "p",
      diagrams: { architecture: { id: "d1", type: "architecture", baseVersion: null } },
      lastSyncedCommit: null,
    }),
  );
  await writeFile(join(dir, ".drawcms", "architecture.json"), JSON.stringify(validSpec));

  const { code, stdout } = await run(["local", "architecture"], dir);
  assert.equal(code, 0, stdout);
  const r = JSON.parse(stdout);
  // Default out path for a tracked name lives under .drawcms/.
  assert.equal(r.out, join(".drawcms", "architecture.local.json"));
});

test("local fails closed on an invalid spec (same engine as build)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drawcms-local-"));
  const specPath = join(dir, "bad.json");
  await writeFile(
    specPath,
    JSON.stringify({ diagramType: "architecture", nodes: [{ id: "a", label: "x", type: "not-real" }], edges: [] }),
  );
  const { code, stdout } = await run(["local", "architecture", specPath], dir);
  assert.equal(code, 1);
  const r = JSON.parse(stdout);
  assert.equal(r.ok, false);
  assert.ok((r.issues ?? []).length >= 1);
});

test("local rejects an unsafe --editor origin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drawcms-local-"));
  const specPath = join(dir, "arch.json");
  await writeFile(specPath, JSON.stringify(validSpec));
  const { code, stdout } = await run(
    ["local", "architecture", specPath, "--editor", "http://evil.example"],
    dir,
  );
  assert.equal(code, 1);
  assert.equal(JSON.parse(stdout).error.code, "INSECURE_ORIGIN");
});

test("local accepts a localhost --editor origin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drawcms-local-"));
  const specPath = join(dir, "arch.json");
  await writeFile(specPath, JSON.stringify(validSpec));
  const { code, stdout } = await run(
    ["local", "architecture", specPath, "--editor", "http://localhost:3002"],
    dir,
  );
  assert.equal(code, 0, stdout);
  assert.equal(JSON.parse(stdout).editor, "http://localhost:3002");
});
