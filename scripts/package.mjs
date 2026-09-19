#!/usr/bin/env node
// Assembles the distributable skill folder at dist/drawcms/ and zips it to
// dist/drawcms-skill.zip. The distributable is exactly what an agent needs —
// SKILL.md, the CLI, the bundled engine, examples, and references — with no
// node_modules or tests. The engine must be present first
// (npm run fetch-engine); this script fails loudly if it is missing so a zip
// never ships without a working engine.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DIST = join(ROOT, "dist");
const OUT = join(DIST, "drawcms");

// Files/dirs that make up the shippable skill.
const INCLUDE = [
  "SKILL.md",
  "README.md",
  "package.json",
  "skill-release.json",
  "bin",
  "lib",
  "examples",
  "references",
  "scripts/fetch-engine.mjs",
  "scripts/build-engine.mjs",
  "scripts/xyflow-stub.mjs",
];

function main() {
  if (!existsSync(join(ROOT, "lib", "engine.mjs"))) {
    console.error("lib/engine.mjs is missing. Run: npm run fetch-engine");
    process.exit(1);
  }

  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  for (const rel of INCLUDE) {
    const src = join(ROOT, rel);
    if (!existsSync(src)) {
      console.error(`Refusing to package: missing ${rel}`);
      process.exit(1);
    }
    const dest = join(OUT, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
  }

  // Zip from within dist so the archive root is `drawcms/`.
  const zipPath = join(DIST, "drawcms-skill.zip");
  rmSync(zipPath, { force: true });
  try {
    execFileSync("zip", ["-rq", zipPath, "drawcms"], { cwd: DIST, stdio: "inherit" });
  } catch {
    console.warn("`zip` not available — folder is at dist/drawcms/, archive skipped.");
    console.log(`Packaged skill folder: ${OUT}`);
    return;
  }
  console.log(`Packaged skill folder: ${OUT}`);
  console.log(`Packaged archive:      ${zipPath}`);
}

main();
