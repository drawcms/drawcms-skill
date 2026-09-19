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

/**
 * Full-loop end-to-end against a single fake server that implements every
 * endpoint the CLI touches — device flow, workspaces/projects/diagrams, and
 * per-diagram document/save with real optimistic-concurrency semantics. It
 * chains login → init → author → build → push → pull → status → diff exactly as
 * an agent would, proving the pieces fit together (the individual endpoint
 * contracts are covered against real cloud handlers in drawcms-cloud tests).
 */
function makeServer() {
  const state = {
    approved: false,
    // Per-diagram store: id -> { version, document }.
    diagrams: new Map(),
    projects: [],
  };

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      const url = new URL(req.url, "http://x");
      const authed = (req.headers.authorization || "").startsWith("Bearer ");

      // --- device flow ---
      if (url.pathname === "/api/auth/device/code" && req.method === "POST") {
        return json(200, {
          device_code: "dev",
          user_code: "AAAA-BBBB",
          verification_uri: "/device",
          verification_uri_complete: null,
          expires_in: 900,
          interval: 1,
        });
      }
      if (url.pathname === "/api/auth/device/token" && req.method === "POST") {
        // Approve on the first poll to keep the test fast.
        state.approved = true;
        return json(200, { access_token: "sess-tok", token_type: "Bearer", expires_in: 3600 });
      }
      if (url.pathname === "/api/auth/get-session" && req.method === "GET") {
        return authed ? json(200, { user: { id: "u1", email: "e2e@example.com", name: "E2E" } }) : json(200, {});
      }

      if (!authed) return json(401, { ok: false, error: { code: "AUTH_REQUIRED", message: "no" } });

      // --- workspaces / projects / diagrams ---
      if (url.pathname === "/api/v1/workspaces" && req.method === "GET") {
        return json(200, {
          ok: true,
          workspaces: [{ id: "team-1", name: "Personal", slug: "personal-abc", role: "owner", plan: "free" }],
        });
      }
      if (url.pathname === "/api/v1/projects" && req.method === "POST") {
        const { name } = JSON.parse(body);
        const project = { id: `proj-${state.projects.length + 1}`, name, teamId: "team-1" };
        state.projects.push(project);
        return json(200, { ok: true, project });
      }
      if (url.pathname === "/api/v1/diagrams" && req.method === "POST") {
        const id = `diag-${state.diagrams.size + 1}`;
        state.diagrams.set(id, { version: 1, document: { meta: { name: "Untitled" }, nodes: [], edges: [] } });
        return json(200, { ok: true, diagram: { id, teamId: "team-1", projectId: JSON.parse(body).projectId } });
      }

      // --- per-diagram document / save (optimistic concurrency) ---
      const docMatch = url.pathname.match(/^\/api\/diagrams\/([^/]+)\/document$/);
      if (docMatch && req.method === "GET") {
        const d = state.diagrams.get(docMatch[1]);
        if (!d) return json(404, { ok: false, error: { code: "NOT_FOUND", message: "x" } });
        return json(200, { ok: true, document: d.document, version: d.version });
      }
      const saveMatch = url.pathname.match(/^\/api\/diagrams\/([^/]+)\/save$/);
      if (saveMatch && req.method === "POST") {
        const d = state.diagrams.get(saveMatch[1]);
        if (!d) return json(404, { ok: false, error: { code: "NOT_FOUND", message: "x" } });
        const input = JSON.parse(body);
        if (input.baseVersion !== undefined && input.baseVersion !== d.version && input.force !== true) {
          return json(409, { ok: false, error: { code: "CONFLICT", message: "moved" } });
        }
        d.version += 1;
        d.document = {
          meta: { name: input.name ?? d.document.meta.name },
          nodes: input.nodes,
          edges: input.edges,
          motion: input.motion ?? null,
        };
        return json(200, { ok: true, version: d.version, revisionNumber: d.version });
      }

      json(404, { ok: false, error: { code: "NOT_FOUND", message: url.pathname } });
    });
  });
  return { server, state };
}

async function run(args, env, cwd) {
  try {
    const { stdout } = await execFileAsync("node", [BIN, ...args, "--json"], {
      cwd,
      env: { ...process.env, DRAWCMS_NO_BROWSER: "1", ...env },
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "" };
  }
}

test("full loop: login → init → author → build → push → pull → status → diff", async () => {
  const { server, state } = makeServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const configHome = await mkdtemp(join(tmpdir(), "drawcms-e2e-home-"));
  const repo = await mkdtemp(join(tmpdir(), "drawcms-e2e-repo-"));
  // A minimal git repo so status/diff and lastSyncedCommit work.
  await execFileAsync("git", ["init", "-q"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "e2e@example.com"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "E2E"], { cwd: repo });
  await writeFile(join(repo, "server.js"), "// app\n");
  await execFileAsync("git", ["add", "."], { cwd: repo });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: repo });

  const env = { DRAWCMS_CONFIG_HOME: configHome };
  const cli = (args) => run(args, env, repo);

  try {
    // 1. login (device flow, auto-approved by the fake server on first poll).
    const login = await cli(["login", "--origin", origin]);
    assert.equal(login.code, 0, login.stdout);
    assert.equal(JSON.parse(login.stdout).user.email, "e2e@example.com");
    assert.ok(state.approved);

    // 2. init — binds the repo, creates one architecture diagram.
    const init = await cli(["init", "--origin", origin]);
    assert.equal(init.code, 0, init.stdout);
    const initReceipt = JSON.parse(init.stdout);
    assert.equal(initReceipt.diagram.type, "architecture");

    // 3. author a real spec into the tracked file.
    const spec = {
      name: "Sample app runtime architecture",
      diagramType: "architecture",
      nodes: [
        { id: "web", label: "Web", type: "arch-frontend" },
        { id: "api", label: "API", type: "arch-backend" },
        { id: "db", label: "Postgres", type: "arch-database" },
      ],
      edges: [
        { source: "web", target: "api", label: "HTTPS" },
        { source: "api", target: "db", label: "SQL" },
      ],
    };
    await mkdir(join(repo, ".drawcms"), { recursive: true });
    await writeFile(join(repo, ".drawcms", "architecture.json"), JSON.stringify(spec, null, 2) + "\n");

    // 4. build — headless validation passes.
    const build = await cli(["build", "architecture", ".drawcms/architecture.json"]);
    assert.equal(build.code, 0, build.stdout);
    assert.equal(JSON.parse(build.stdout).summary.nodes, 3);

    // 5. push — validates + saves; records version + commit.
    const push = await cli(["push"]);
    assert.equal(push.code, 0, push.stdout);
    const pushReceipt = JSON.parse(push.stdout);
    assert.equal(pushReceipt.results[0].status, "pushed");
    assert.ok(pushReceipt.lastSyncedCommit);
    // The push receipt surfaces a clickable diagram URL and the real title.
    assert.match(pushReceipt.results[0].url, /\/editor\//);
    assert.equal(pushReceipt.results[0].diagramName, "Sample app runtime architecture");

    // 6. pull — brings back the saved document, no local-edit conflict.
    const pull = await cli(["pull"]);
    assert.equal(pull.code, 0, pull.stdout);
    assert.equal(JSON.parse(pull.stdout).results[0].status, "pulled");

    // 7. status — clean, diagrams at HEAD.
    const status = await cli(["status"]);
    assert.equal(status.code, 0, status.stdout);
    const statusReceipt = JSON.parse(status.stdout);
    assert.equal(statusReceipt.git.behind, false);
    assert.equal(statusReceipt.diagrams[0].local, "clean");

    // 8. new commit → status reports drift, diff lists the changed file.
    await writeFile(join(repo, "worker.js"), "// worker\n");
    await execFileAsync("git", ["add", "."], { cwd: repo });
    await execFileAsync("git", ["commit", "-q", "-m", "add worker"], { cwd: repo });
    const status2 = await cli(["status"]);
    assert.equal(JSON.parse(status2.stdout).git.behind, true);
    const diff = await cli(["diff"]);
    assert.ok(JSON.parse(diff.stdout).git.changedFiles.includes("worker.js"));

    // 9. the cloud copy now holds the pushed topology.
    const stored = [...state.diagrams.values()][0];
    assert.equal(stored.document.nodes.length, 3);
    assert.equal(stored.version, 2); // 1 at create, +1 on push
  } finally {
    server.close();
  }
});

test("full loop docs exist for the live preview:cloudflare run", async () => {
  const docs = await readFile(join(ROOT, "docs", "E2E.md"), "utf8");
  assert.match(docs, /preview:cloudflare/);
  assert.match(docs, /db:push/);
});
