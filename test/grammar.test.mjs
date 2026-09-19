import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(resolve(HERE, ".."), "bin", "drawcms.mjs");

async function cli(args) {
  try {
    const { stdout } = await execFileAsync("node", [BIN, ...args]);
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "" };
  }
}

test("grammar with no id lists elements and motion presets", async () => {
  const { code, stdout } = await cli(["grammar", "--json"]);
  assert.equal(code, 0);
  const receipt = JSON.parse(stdout);
  assert.ok(receipt.elementCount > 100);
  assert.ok(receipt.elements.includes("infra-redis"));
  assert.ok(receipt.motions.includes("Data Flow"));
});

test("grammar describes a specific element", async () => {
  const { code, stdout } = await cli(["grammar", "infra-redis", "--json"]);
  assert.equal(code, 0);
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.kind, "element");
  assert.equal(receipt.entry.id, "infra-redis");
  assert.ok(receipt.entry.purpose);
});

test("grammar describes a motion preset", async () => {
  const { code, stdout } = await cli(["grammar", "Data Flow", "--json"]);
  assert.equal(code, 0);
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.kind, "motion");
  assert.equal(receipt.entry.id, "Data Flow");
});

test("grammar on an unknown id exits non-zero", async () => {
  const { code, stdout } = await cli(["grammar", "not-a-real-element", "--json"]);
  assert.equal(code, 1);
  assert.equal(JSON.parse(stdout).error.code, "UNKNOWN_ID");
});
