import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

test("SKILL.md lint passes (frontmatter + referenced files exist)", async () => {
  const { stdout } = await execFileAsync("node", [join(ROOT, "scripts", "check-skill.mjs")]);
  assert.match(stdout, /lint passed/);
});

test("SKILL.md frontmatter has the trigger-rich description", () => {
  const text = readFileSync(join(ROOT, "SKILL.md"), "utf8");
  assert.match(text, /^name: drawcms$/m);
  assert.match(text, /Use when the user asks/);
  // Names all five diagram types so the router is discoverable from the doc.
  for (const t of ["architecture", "flowchart", "sequence", "data-flow", "lifecycle"]) {
    assert.ok(text.includes(t), `SKILL.md should mention ${t}`);
  }
});
