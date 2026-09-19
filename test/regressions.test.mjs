import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { resolveOrigin } from "../lib/config.mjs";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const BIN = join(ROOT, "bin", "drawcms.mjs");

async function cli(args, { configHome, cwd }) {
  try {
    const { stdout } = await execFileAsync("node", [BIN, ...args, "--json"], {
      cwd,
      env: {
        ...process.env,
        DRAWCMS_CONFIG_HOME: configHome,
        DRAWCMS_NO_BROWSER: "1",
        // Must not leak from the ambient shell into these assertions.
        DRAWCMS_ORIGIN: "",
      },
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "" };
  }
}

/**
 * Regression: the repo's bound origin must outrank the global login origin.
 * Previously pull/push merged them as `{ origin: link.origin, ...config }`, so
 * the global value won and a repo bound to a self-hosted or staging server
 * silently sent its traffic to production.
 */
test("resolveOrigin: repo link origin beats the global config origin", () => {
  const got = resolveOrigin({}, { origin: "https://drawcms.com" }, "http://localhost:3000");
  assert.equal(got, "http://localhost:3000");
});

test("resolveOrigin: explicit flag and env still outrank the repo link", () => {
  assert.equal(
    resolveOrigin({ origin: "https://flag.example" }, { origin: "https://cfg" }, "https://link"),
    "https://flag.example",
  );
  const prev = process.env.DRAWCMS_ORIGIN;
  process.env.DRAWCMS_ORIGIN = "https://env.example";
  try {
    assert.equal(resolveOrigin({}, { origin: "https://cfg" }, "https://link"), "https://env.example");
  } finally {
    if (prev === undefined) delete process.env.DRAWCMS_ORIGIN;
    else process.env.DRAWCMS_ORIGIN = prev;
  }
});

test("resolveOrigin: falls back to the global config, then the default", () => {
  assert.equal(resolveOrigin({}, { origin: "https://cfg.example" }, undefined), "https://cfg.example");
  assert.match(resolveOrigin({}, {}, undefined), /^https:\/\//);
});

/** Regression: a corrupt config produced a bare "Unexpected token" with no
 * indication of which file was broken or how to recover. `login` is the probe
 * here because it reads the global config first; `push`/`pull` legitimately
 * report NOT_INITIALIZED before ever looking at it. */
test("a corrupt global config reports CONFIG_CORRUPT naming the file", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "drawcms-reg-"));
  const cwd = await mkdtemp(join(tmpdir(), "drawcms-reg-repo-"));
  await writeFile(join(configHome, "config.json"), "{ not json");
  // Fails on the corrupt file before any network call is attempted.
  const { code, stdout } = await cli(["login", "--origin", "http://127.0.0.1:1"], { configHome, cwd });
  assert.equal(code, 1);
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.error.code, "CONFIG_CORRUPT");
  assert.match(receipt.error.message, /config\.json is not valid JSON/);
  assert.match(receipt.error.message, /drawcms login/);
});

test("a corrupt repo link reports PROJECT_CONFIG_CORRUPT naming the file", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "drawcms-reg-"));
  const cwd = await mkdtemp(join(tmpdir(), "drawcms-reg-repo-"));
  await writeFile(join(configHome, "config.json"), JSON.stringify({ token: "t" }));
  await mkdir(join(cwd, ".drawcms"), { recursive: true });
  await writeFile(join(cwd, ".drawcms", "config.json"), "{ broken");
  const { code, stdout } = await cli(["status"], { configHome, cwd });
  assert.equal(code, 1);
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.error.code, "PROJECT_CONFIG_CORRUPT");
  assert.match(receipt.error.message, /drawcms init/);
});

/** Regression: a login failure must name the origin it tried and hint at
 * DRAWCMS_ORIGIN. An agent testing locally that forgets to set the origin hits
 * production (drawcms.com) and gets an opaque server error; naming the origin
 * is the clue that lets it self-correct. Reproduces the real OpenCode session
 * where the agent hit https://drawcms.com and could not tell why. */
test("login failure names the origin it tried and hints at DRAWCMS_ORIGIN", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "drawcms-reg-"));
  const cwd = await mkdtemp(join(tmpdir(), "drawcms-reg-repo-"));
  // A closed port forces the device-code request to fail fast.
  const { code, stdout } = await cli(["login", "--begin", "--origin", "http://127.0.0.1:59919"], {
    configHome,
    cwd,
  });
  assert.equal(code, 1);
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.error.code, "DEVICE_CODE_FAILED");
  assert.equal(receipt.origin, "http://127.0.0.1:59919");
  assert.match(receipt.error.message, /127\.0\.0\.1:59919/);
  assert.match(receipt.error.message, /DRAWCMS_ORIGIN/);
});

/** Regression: lib/engine.mjs is generated and gitignored, so a fresh checkout
 * has none. Engine-dependent commands must say to build it, not emit a bare
 * module-not-found.
 *
 * This runs against a throwaway copy of the skill with the engine omitted —
 * never by renaming the real bundle, which would break other test files
 * executing concurrently. */
test("engine-dependent commands report ENGINE_MISSING with the build command", async () => {
  const { cpSync } = await import("node:fs");
  const stage = await mkdtemp(join(tmpdir(), "drawcms-noengine-"));
  const skillCopy = join(stage, "skill");
  cpSync(ROOT, skillCopy, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(ROOT.length);
      // Omit the generated engine (the condition under test) plus anything
      // irrelevant/heavy.
      if (rel.endsWith(join("lib", "engine.mjs"))) return false;
      return !/(^|\/)(node_modules|dist|test|\.git)(\/|$)/.test(rel);
    },
  });

  const bin = join(skillCopy, "bin", "drawcms.mjs");
  const configHome = await mkdtemp(join(tmpdir(), "drawcms-reg-"));
  const cwd = await mkdtemp(join(tmpdir(), "drawcms-reg-repo-"));

  for (const command of [
    ["build", "architecture", join(ROOT, "examples", "architecture.json")],
    ["push"],
  ]) {
    let stdout = "";
    let code = 0;
    try {
      ({ stdout } = await execFileAsync("node", [bin, ...command, "--json"], {
        cwd,
        env: { ...process.env, DRAWCMS_CONFIG_HOME: configHome, DRAWCMS_ORIGIN: "" },
      }));
    } catch (error) {
      code = error.code ?? 1;
      stdout = error.stdout ?? "";
    }
    assert.equal(code, 1, `${command[0]} should fail without the engine`);
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.error.code, "ENGINE_MISSING");
    assert.match(receipt.error.message, /fetch-engine/);
  }
});
