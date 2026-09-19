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

const validSpec = {
  diagramType: "architecture",
  meta: { name: "Arch", diagramType: "architecture" },
  nodes: [
    { id: "a", label: "Browser", type: "arch-frontend" },
    { id: "b", label: "API", type: "arch-backend" },
  ],
  edges: [{ source: "a", target: "b", label: "HTTPS" }],
};

async function withServer(run, { mode = "ok", version = 5, cloudDocument = null } = {}) {
  const state = { saves: [] };
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
      if (req.url === `/api/diagrams/${DIAGRAM_ID}/document` && req.method === "GET") {
        return json(200, {
          ok: true,
          version,
          document: cloudDocument ?? { meta: { name: "Cloud copy" }, nodes: [], edges: [] },
        });
      }
      if (req.url === `/api/diagrams/${DIAGRAM_ID}/save` && req.method === "POST") {
        state.saves.push(JSON.parse(body));
        if (mode === "conflict") {
          return json(409, { ok: false, error: { code: "CONFLICT", message: "moved" } });
        }
        return json(200, { ok: true, version, revisionNumber: 2 });
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

async function setup(origin, { docContent = validSpec, baseVersion = 4, loginOrigin = undefined } = {}) {
  const configHome = await mkdtemp(join(tmpdir(), "drawcms-push-home-"));
  const repo = await mkdtemp(join(tmpdir(), "drawcms-push-repo-"));
  await writeFile(
    join(configHome, "config.json"),
    JSON.stringify(loginOrigin ? { token: "tok", origin: loginOrigin } : { token: "tok" }),
  );
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
  await writeFile(
    join(repo, ".drawcms", "architecture.json"),
    JSON.stringify(docContent, null, 2) + "\n",
  );
  // Make it a git repo with one commit so headCommit() resolves.
  await execFileAsync("git", ["init", "-q"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "t@e.com"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "T"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "# repo\n");
  await execFileAsync("git", ["add", "."], { cwd: repo });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
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

/** Like cli() but does NOT pass --origin, so the command resolves the origin
 * from the repo link. Used to exercise the cross-origin token gate, which is
 * bypassed by an explicit --origin. */
async function cliNoOrigin(args, { configHome, repo, env = {} }) {
  try {
    const { stdout } = await execFileAsync("node", [BIN, ...args, "--json"], {
      cwd: repo,
      env: { ...process.env, DRAWCMS_CONFIG_HOME: configHome, DRAWCMS_NO_BROWSER: "1", ...env },
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "" };
  }
}

test("push validates, saves with baseVersion, and records version + lastSyncedCommit", async () => {
  await withServer(async (origin, state) => {
    const { configHome, repo } = await setup(origin);
    const { code, stdout } = await cli(["push"], { configHome, repo, origin });
    assert.equal(code, 0, stdout);
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.results[0].status, "pushed");
    assert.equal(receipt.results[0].version, 5);
    assert.ok(receipt.lastSyncedCommit, "should stamp lastSyncedCommit");

    // The save payload carried the baseVersion and a name derived from meta.
    assert.equal(state.saves[0].baseVersion, 4);
    assert.equal(state.saves[0].name, "Arch");
    assert.ok(Array.isArray(state.saves[0].nodes));

    const link = JSON.parse(await readFile(join(repo, ".drawcms", "config.json"), "utf8"));
    assert.equal(link.diagrams.architecture.baseVersion, 5);
    assert.ok(link.lastSyncedCommit);
    assert.ok(link.diagrams.architecture.pulledHash);
  });
});

test("push fails closed on an invalid document without hitting the network", async () => {
  await withServer(async (origin, state) => {
    const { configHome, repo } = await setup(origin, {
      docContent: { diagramType: "architecture", nodes: [{ id: "a", label: "x", type: "not-real" }], edges: [] },
    });
    const { code, stdout } = await cli(["push"], { configHome, repo, origin });
    assert.equal(code, 1);
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.results[0].status, "invalid");
    assert.ok(receipt.results[0].issues.length >= 1);
    assert.equal(state.saves.length, 0, "must not call save for an invalid doc");
  });
});

test("push refuses on a version conflict", async () => {
  await withServer(
    async (origin) => {
      const { configHome, repo } = await setup(origin);
      const { code, stdout } = await cli(["push"], { configHome, repo, origin });
      assert.equal(code, 1);
      assert.equal(JSON.parse(stdout).results[0].status, "conflict");
    },
    { mode: "conflict" },
  );
});

test("push refuses a diagram left with the generic default name", async () => {
  await withServer(async (origin, state) => {
    // A spec with no name -> engine stamps "AI-generated diagram".
    const { configHome, repo } = await setup(origin, {
      docContent: {
        diagramType: "architecture",
        nodes: [
          { id: "a", label: "Browser", type: "arch-frontend" },
          { id: "b", label: "API", type: "arch-backend" },
        ],
        edges: [{ source: "a", target: "b", label: "HTTPS" }],
      },
    });
    const { code, stdout } = await cli(["push"], { configHome, repo, origin });
    assert.equal(code, 1);
    assert.equal(JSON.parse(stdout).results[0].status, "unnamed");
    assert.equal(state.saves.length, 0, "an unnamed diagram must not be saved");
  });
});

test("push returns the diagram URL and title on success", async () => {
  await withServer(async (origin) => {
    const { configHome, repo } = await setup(origin);
    const { code, stdout } = await cli(["push"], { configHome, repo, origin });
    assert.equal(code, 0, stdout);
    const r = JSON.parse(stdout).results[0];
    assert.equal(r.status, "pushed");
    assert.equal(r.url, `${origin}/editor/${DIAGRAM_ID}`);
    assert.equal(r.diagramName, "Arch");
  });
});

test("push --force stashes the cloud revision it overwrites", async () => {
  const cloudDocument = {
    meta: { name: "Human-arranged copy" },
    nodes: [{ id: "z", data: { label: "Dragged node" }, position: { x: 999, y: 999 } }],
    edges: [],
  };
  await withServer(
    async (origin, state) => {
      const { configHome, repo } = await setup(origin);
      const { code, stdout } = await cli(["push", "--force"], { configHome, repo, origin });
      assert.equal(code, 0, stdout);
      const r = JSON.parse(stdout).results[0];
      assert.equal(r.status, "pushed");
      // The save was forced (skips the conflict check).
      assert.equal(state.saves[0].force, true);
      // The overwritten cloud document was stashed locally, wrapped with metadata.
      assert.ok(r.stashedTo, "push --force should report a stash path");
      const stash = JSON.parse(await readFile(join(repo, ".drawcms", "architecture.stash.json"), "utf8"));
      assert.equal(stash.document.meta.name, "Human-arranged copy");
      assert.equal(stash.document.nodes[0].id, "z");
      assert.match(stash.reason, /push --force/);
    },
    { cloudDocument },
  );
});

test("push without --force does not create a stash file", async () => {
  await withServer(async (origin) => {
    const { configHome, repo } = await setup(origin);
    const { code } = await cli(["push"], { configHome, repo, origin });
    assert.equal(code, 0);
    let exists = true;
    try {
      await readFile(join(repo, ".drawcms", "architecture.stash.json"), "utf8");
    } catch {
      exists = false;
    }
    assert.equal(exists, false, "a normal push must not write a stash");
  });
});

test("push refuses to send the token cross-origin unless acknowledged", async () => {
  await withServer(async (origin, state) => {
    // Logged in at a *different* origin than the repo is bound to. No --origin,
    // so the repo link origin (the fake server) is resolved and the gate fires.
    const { configHome, repo } = await setup(origin, { loginOrigin: "https://drawcms.com" });
    const { code, stdout } = await cliNoOrigin(["push"], { configHome, repo });
    assert.equal(code, 1);
    assert.equal(JSON.parse(stdout).error.code, "CROSS_ORIGIN_TOKEN");
    assert.equal(state.saves.length, 0, "must not send the token before it is acknowledged");
  });
});

test("push proceeds cross-origin when acknowledged with --origin", async () => {
  await withServer(async (origin, state) => {
    const { configHome, repo } = await setup(origin, { loginOrigin: "https://drawcms.com" });
    // Passing --origin explicitly acknowledges the cross-origin send.
    const { code } = await cli(["push"], { configHome, repo, origin });
    assert.equal(code, 0);
    assert.equal(state.saves.length, 1);
  });
});

test("push proceeds cross-origin when acknowledged with DRAWCMS_ALLOW_CROSS_ORIGIN", async () => {
  await withServer(async (origin, state) => {
    const { configHome, repo } = await setup(origin, { loginOrigin: "https://drawcms.com" });
    const { code } = await cliNoOrigin(["push"], {
      configHome,
      repo,
      env: { DRAWCMS_ALLOW_CROSS_ORIGIN: "1" },
    });
    assert.equal(code, 0);
    assert.equal(state.saves.length, 1);
  });
});

test("push fails when not initialized", async () => {
  await withServer(async (origin) => {
    const configHome = await mkdtemp(join(tmpdir(), "drawcms-push-home-"));
    const repo = await mkdtemp(join(tmpdir(), "drawcms-push-repo-"));
    await writeFile(join(configHome, "config.json"), JSON.stringify({ token: "tok" }));
    const { code, stdout } = await cli(["push"], { configHome, repo, origin });
    assert.equal(code, 1);
    assert.equal(JSON.parse(stdout).error.code, "NOT_INITIALIZED");
  });
});
