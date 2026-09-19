#!/usr/bin/env node
// Lints SKILL.md: required frontmatter fields are present, and every file the
// skill references (references/*.md, examples/*.json) actually exists. Keeps the
// skill self-consistent so an agent never follows a pointer to a missing file.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SKILL = join(ROOT, "SKILL.md");

const problems = [];

if (!existsSync(SKILL)) {
  console.error("SKILL.md is missing");
  process.exit(1);
}
const text = readFileSync(SKILL, "utf8");

// 1. Frontmatter block.
const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
if (!fm) {
  problems.push("SKILL.md has no YAML frontmatter block");
} else {
  const body = fm[1];
  for (const field of ["name", "description", "license"]) {
    if (!new RegExp(`^${field}:`, "m").test(body)) {
      problems.push(`frontmatter missing required field: ${field}`);
    }
  }
  const nameLine = body.match(/^name:\s*(.+)$/m);
  if (nameLine && nameLine[1].trim() !== "drawcms") {
    problems.push(`frontmatter name should be "drawcms", got "${nameLine[1].trim()}"`);
  }
  const desc = body.match(/^description:\s*(.+)$/m);
  if (desc && desc[1].trim().length < 40) {
    problems.push("frontmatter description is too short to trigger reliably");
  }
}

// 2. The skill must tell the agent how to resolve the CLI. Installing a skill
//    folder does not put its bin on PATH, so a bare `drawcms` may not exist;
//    without the documented absolute-path fallback the agent dead-ends on the
//    first command.
if (!text.includes("bin/drawcms.mjs")) {
  problems.push(
    "SKILL.md must document the `node <skill-folder>/bin/drawcms.mjs` fallback (drawcms is not on PATH by default)",
  );
}

// 3. Every referenced repo-relative file exists.
const referenced = new Set();
for (const m of text.matchAll(/`(references\/[A-Za-z0-9._/-]+|examples\/[A-Za-z0-9._/-]+)`/g)) {
  let ref = m[1];
  // Expand a glob like examples/*.json to each primary type.
  if (ref.includes("*")) {
    if (ref === "examples/*.json") {
      for (const t of ["architecture", "flowchart", "sequence", "data-flow", "lifecycle"]) {
        referenced.add(`examples/${t}.json`);
      }
    }
    continue;
  }
  referenced.add(ref);
}
for (const ref of referenced) {
  if (!existsSync(join(ROOT, ref))) {
    problems.push(`SKILL.md references a missing file: ${ref}`);
  }
}

// 4. The referenced example files must be valid JSON and buildable in principle
//    (parse only — full build is covered by the test suite).
for (const ref of referenced) {
  if (ref.endsWith(".json") && existsSync(join(ROOT, ref))) {
    try {
      JSON.parse(readFileSync(join(ROOT, ref), "utf8"));
    } catch (error) {
      problems.push(`example ${ref} is not valid JSON: ${error.message}`);
    }
  }
}

// 5. The vocabulary reference must keep the brand-element mapping, since the
//    skill's element-selection guidance points the agent at it. A regression
//    that drops these tables would silently send agents back to generic boxes.
const vocabPath = join(ROOT, "references", "vocabulary.md");
if (existsSync(vocabPath)) {
  const vocab = readFileSync(vocabPath, "utf8");
  for (const marker of ["infra-redis", "infra-postgresql", "aws-s3", "gcp-bigquery", "azure-cosmos-db"]) {
    if (!vocab.includes(marker)) {
      problems.push(`references/vocabulary.md is missing the brand element "${marker}"`);
    }
  }
}

if (problems.length) {
  console.error("SKILL.md lint failed:");
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log("SKILL.md lint passed.");
