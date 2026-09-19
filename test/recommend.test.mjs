import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const BIN = join(ROOT, "bin", "drawcms.mjs");

async function cli(args) {
  try {
    const { stdout } = await execFileAsync("node", [BIN, ...args]);
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "" };
  }
}

async function entitiesFile(obj) {
  const dir = await mkdtemp(join(tmpdir(), "drawcms-rec-"));
  const path = join(dir, "entities.json");
  await writeFile(path, JSON.stringify(obj));
  return path;
}

test("recommend maps named technologies to their brand elements", async () => {
  const path = await entitiesFile({
    diagramType: "architecture",
    entities: [
      { id: "browser", role: "component", label: "Browser client" },
      { id: "redis", role: "datastore", label: "Redis cache" },
      { id: "pg", role: "datastore", label: "Postgres" },
      { id: "stripe", role: "external", label: "Stripe" },
    ],
  });
  const { code, stdout } = await cli(["recommend", path, "--json"]);
  assert.equal(code, 0);
  const byId = Object.fromEntries(JSON.parse(stdout).suggestions.map((s) => [s.id, s]));
  assert.equal(byId.redis.element, "infra-redis");
  assert.equal(byId.redis.branded, true);
  assert.equal(byId.pg.element, "infra-postgresql");
  // Not an infra brand -> generic category, not flagged as branded.
  assert.equal(byId.browser.element, "arch-frontend");
  assert.equal(byId.browser.branded, false);
  assert.equal(byId.stripe.element, "arch-external");
});

test("recommend flags a brand suggestion for confirmation rather than trusting it", async () => {
  const path = await entitiesFile({
    entities: [{ id: "x", role: "component", label: "Postgres-compatible layer we built" }],
  });
  const { code, stdout } = await cli(["recommend", path, "--json"]);
  assert.equal(code, 0);
  const receipt = JSON.parse(stdout);
  // The engine keys off the word "Postgres" with no repo awareness — the
  // suggestion is still surfaced, but branded + carries the confirm caveat.
  assert.equal(receipt.suggestions[0].element, "infra-postgresql");
  assert.equal(receipt.suggestions[0].branded, true);
  assert.match(receipt.note, /confirm/i);
});

test("recommend rejects input without an entities array", async () => {
  const path = await entitiesFile({ diagramType: "architecture" });
  const { code, stdout } = await cli(["recommend", path, "--json"]);
  assert.equal(code, 1);
  assert.equal(JSON.parse(stdout).issues[0].code, "INVALID_INPUT");
});

test("recommend on a missing file exits non-zero", async () => {
  const { code, stdout } = await cli(["recommend", "does-not-exist.json", "--json"]);
  assert.equal(code, 1);
  assert.equal(JSON.parse(stdout).issues[0].code, "FILE_NOT_READABLE");
});
