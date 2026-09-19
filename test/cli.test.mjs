import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const BIN = join(ROOT, "bin", "drawcms.mjs");
const EXAMPLES = join(ROOT, "examples");

/** Run the CLI and capture exit code + stdout/stderr without throwing. */
async function cli(args) {
  try {
    const { stdout, stderr } = await execFileAsync("node", [BIN, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("doctor exits 0 and reports the engine in --json", async () => {
  const { code, stdout } = await cli(["doctor", "--json"]);
  assert.equal(code, 0);
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.command, "doctor");
  assert.ok(receipt.editorVersion, "should report the bundled editor version");
});

test("build of a valid example exits 0 with a JSON receipt", async () => {
  const { code, stdout } = await cli(["build", "architecture", join(EXAMPLES, "architecture.json"), "--json"]);
  assert.equal(code, 0);
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.diagramType, "architecture");
  assert.ok(receipt.summary.nodes >= 2);
  assert.ok(receipt.document, "JSON mode should include the built document");
});

test("build with the type inferred from the spec exits 0", async () => {
  const { code, stdout } = await cli(["build", join(EXAMPLES, "sequence.json"), "--json"]);
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).diagramType, "sequence");
});

test("build of a missing file exits non-zero with FILE_NOT_READABLE", async () => {
  const { code, stdout } = await cli(["build", "architecture", "does-not-exist.json", "--json"]);
  assert.equal(code, 1);
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.issues[0].code, "FILE_NOT_READABLE");
});

test("build with an unknown CLI type exits non-zero", async () => {
  const { code, stdout } = await cli(["build", "banana", join(EXAMPLES, "architecture.json"), "--json"]);
  assert.equal(code, 1);
  assert.equal(JSON.parse(stdout).issues[0].code, "UNKNOWN_TYPE");
});

test("build of malformed JSON exits non-zero with INVALID_JSON", async () => {
  // Write a temp bad file.
  const { writeFile, mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "drawcms-cli-"));
  const bad = join(dir, "bad.json");
  await writeFile(bad, "{ not json ");
  const { code, stdout } = await cli(["build", "flowchart", bad, "--json"]);
  assert.equal(code, 1);
  assert.equal(JSON.parse(stdout).issues[0].code, "INVALID_JSON");
});

test("unknown command exits non-zero", async () => {
  const { code } = await cli(["frobnicate"]);
  assert.equal(code, 1);
});
