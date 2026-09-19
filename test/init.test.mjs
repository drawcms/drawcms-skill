import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const BIN = join(ROOT, "bin", "drawcms.mjs");

/** Fake cloud implementing the /api/v1 surface init touches. */
async function withServer(run, { workspaces } = {}) {
  const state = { createdProjects: [], createdDiagrams: [] };
  const ws = workspaces ?? [
    { id: "team-personal", name: "Personal Workspace", slug: "personal-abc123", role: "owner", plan: "free" },
  ];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      const authed = (req.headers.authorization || "").startsWith("Bearer ");
      if (!authed) return json(401, { ok: false, error: { code: "AUTH_REQUIRED", message: "no" } });
      const url = new URL(req.url, "http://x");

      if (url.pathname === "/api/v1/workspaces" && req.method === "GET") {
        return json(200, { ok: true, workspaces: ws });
      }
      if (url.pathname === "/api/v1/projects" && req.method === "GET") {
        return json(200, { ok: true, projects: state.createdProjects.map((p) => ({ ...p, diagramCount: 0 })) });
      }
      if (url.pathname === "/api/v1/projects" && req.method === "POST") {
        const { name, teamId } = JSON.parse(body);
        const project = { id: `proj-${state.createdProjects.length + 1}`, name, teamId };
        state.createdProjects.push(project);
        return json(200, { ok: true, project });
      }
      if (url.pathname === "/api/v1/diagrams" && req.method === "POST") {
        const { teamId, projectId } = JSON.parse(body);
        const diagram = { id: `diag-${state.createdDiagrams.length + 1}`, teamId, projectId };
        state.createdDiagrams.push(diagram);
        return json(200, { ok: true, diagram });
      }
      json(404, { ok: false, error: { code: "NOT_FOUND", message: "x" } });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`, state);
  } finally {
    server.close();
  }
}

async function setup() {
  const configHome = await mkdtemp(join(tmpdir(), "drawcms-init-home-"));
  const repo = await mkdtemp(join(tmpdir(), "drawcms-init-repo-"));
  // Pre-seed a logged-in global config.
  await mkdir(configHome, { recursive: true });
  await writeFile(join(configHome, "config.json"), JSON.stringify({ token: "tok-123" }));
  return { configHome, repo };
}

async function cli(args, { configHome, repo, origin }) {
  const fullArgs = [BIN, ...args, "--origin", origin, "--json"];
  try {
    const { stdout } = await execFileAsync("node", fullArgs, {
      cwd: repo,
      env: { ...process.env, DRAWCMS_CONFIG_HOME: configHome, DRAWCMS_NO_BROWSER: "1" },
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "" };
  }
}

test("init binds a repo to a new project and creates an architecture diagram by default", async () => {
  const { configHome, repo } = await setup();
  await withServer(async (origin) => {
    const { code, stdout } = await cli(["init"], { configHome, repo, origin });
    assert.equal(code, 0, stdout);
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.workspace.id, "team-personal");
    assert.equal(receipt.diagram.type, "architecture");

    const cfg = JSON.parse(await readFile(join(repo, ".drawcms", "config.json"), "utf8"));
    assert.equal(cfg.teamId, "team-personal");
    assert.equal(cfg.projectId, "proj-1");
    assert.equal(cfg.lastSyncedCommit, null);
    assert.ok(cfg.diagrams.architecture);
    assert.equal(cfg.diagrams.architecture.baseVersion, null);
  });
});

test("init --no-diagram binds the project only", async () => {
  const { configHome, repo } = await setup();
  await withServer(async (origin) => {
    const { code, stdout } = await cli(["init", "--no-diagram", "--project-name", "My Repo"], {
      configHome,
      repo,
      origin,
    });
    assert.equal(code, 0, stdout);
    const cfg = JSON.parse(await readFile(join(repo, ".drawcms", "config.json"), "utf8"));
    assert.equal(cfg.projectName, "My Repo");
    assert.deepEqual(cfg.diagrams, {});
  });
});

test("init names the project after the repo directory by default", async () => {
  const { configHome, repo } = await setup();
  await withServer(async (origin) => {
    const { code, stdout } = await cli(["init", "--no-diagram"], { configHome, repo, origin });
    assert.equal(code, 0, stdout);
    const cfg = JSON.parse(await readFile(join(repo, ".drawcms", "config.json"), "utf8"));
    // The default project name represents the repo/project, i.e. the working
    // directory's basename — never a generic "Untitled Project" placeholder.
    const expected = repo.split("/").filter(Boolean).pop();
    assert.equal(cfg.projectName, expected);
    assert.notEqual(cfg.projectName, "Untitled Project");
  });
});

test("init writes a .drawcms/.gitignore excluding local stash files", async () => {
  const { configHome, repo } = await setup();
  await withServer(async (origin) => {
    const { code } = await cli(["init", "--no-diagram"], { configHome, repo, origin });
    assert.equal(code, 0);
    const ignore = await readFile(join(repo, ".drawcms", ".gitignore"), "utf8");
    assert.match(ignore, /\*\.stash\.json/);
  });
});

test("init refuses to relink without --force", async () => {
  const { configHome, repo } = await setup();
  await withServer(async (origin) => {
    await cli(["init"], { configHome, repo, origin });
    const { code, stdout } = await cli(["init"], { configHome, repo, origin });
    assert.equal(code, 1);
    assert.equal(JSON.parse(stdout).error.code, "ALREADY_INITIALIZED");
  });
});

test("init fails when not logged in", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "drawcms-init-home-"));
  const repo = await mkdtemp(join(tmpdir(), "drawcms-init-repo-"));
  await withServer(async (origin) => {
    const { code, stdout } = await cli(["init"], { configHome, repo, origin });
    assert.equal(code, 1);
    assert.equal(JSON.parse(stdout).error.code, "NOT_LOGGED_IN");
  });
});

test("init --type rejects an unknown diagram type", async () => {
  const { configHome, repo } = await setup();
  await withServer(async (origin) => {
    const { code, stdout } = await cli(["init", "--type", "banana"], { configHome, repo, origin });
    assert.equal(code, 1);
    assert.equal(JSON.parse(stdout).error.code, "UNKNOWN_TYPE");
  });
});
