import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const BIN = join(ROOT, "bin", "drawcms.mjs");

/**
 * Stand up a fake DrawCMS auth server implementing just the device-flow
 * endpoints the login command touches. `tokenScript` controls the polling
 * outcome sequence: each poll shifts one entry off it.
 */
async function withFakeServer(tokenScript, run) {
  const state = { codeRequests: 0, polls: 0 };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.url === "/api/auth/device/code" && req.method === "POST") {
        state.codeRequests++;
        return json(200, {
          device_code: "dev-123",
          user_code: "ABCD-EFGH",
          verification_uri: "/device",
          verification_uri_complete: null,
          expires_in: 900,
          interval: 1,
        });
      }
      if (req.url === "/api/auth/device/token" && req.method === "POST") {
        const next = tokenScript[state.polls] ?? tokenScript[tokenScript.length - 1];
        state.polls++;
        if (next.access_token) return json(200, next);
        return json(400, next);
      }
      if (req.url === "/api/auth/get-session" && req.method === "GET") {
        const authed = (req.headers.authorization || "").startsWith("Bearer ");
        if (!authed) return json(200, {});
        return json(200, { user: { id: "u1", email: "dev@example.com", name: "Dev" } });
      }
      json(404, { error: "not_found" });
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

async function cli(args, env) {
  try {
    const { stdout, stderr } = await execFileAsync("node", [BIN, ...args], {
      env: { ...process.env, DRAWCMS_NO_BROWSER: "1", ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("login polls until approval and stores a 0600 token", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "drawcms-login-"));
  await withFakeServer(
    [
      { error: "authorization_pending", error_description: "pending" },
      { error: "authorization_pending", error_description: "pending" },
      { access_token: "sess-token-xyz", token_type: "Bearer", expires_in: 3600 },
    ],
    async (origin) => {
      const { code, stdout } = await cli(["login", "--origin", origin, "--json"], {
        DRAWCMS_CONFIG_HOME: configHome,
      });
      assert.equal(code, 0, "login should succeed");
      const receipt = JSON.parse(stdout);
      assert.equal(receipt.ok, true);
      assert.equal(receipt.user.email, "dev@example.com");

      const cfgPath = join(configHome, "config.json");
      const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
      assert.equal(cfg.token, "sess-token-xyz");
      assert.equal(cfg.origin, origin);
      const mode = (await stat(cfgPath)).mode & 0o777;
      assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
    },
  );
});

test("login fails cleanly when the request is denied", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "drawcms-login-"));
  await withFakeServer([{ error: "access_denied", error_description: "denied" }], async (origin) => {
    const { code, stdout } = await cli(["login", "--origin", origin, "--json"], {
      DRAWCMS_CONFIG_HOME: configHome,
    });
    assert.equal(code, 1);
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.ok, false);
    assert.equal(receipt.error.code, "ACCESS_DENIED");
  });
});

test("login fails when the device code request itself fails", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "drawcms-login-"));
  // Point at a closed port to force a network error on the code request.
  const { code, stdout } = await cli(["login", "--origin", "http://127.0.0.1:1", "--json"], {
    DRAWCMS_CONFIG_HOME: configHome,
  });
  assert.equal(code, 1);
  assert.equal(JSON.parse(stdout).error.code, "DEVICE_CODE_FAILED");
});
