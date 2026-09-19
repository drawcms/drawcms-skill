#!/usr/bin/env node
// Fetches lib/engine.mjs: the prebuilt headless DrawCMS engine bundle, published
// as a release asset on the AGPL editor repo (drawcms/drawcms). The skill itself
// is MIT and does not commit or redistribute the AGPL engine — each user
// downloads it here at setup time, pinned to an exact release and verified by
// SHA-256 so a tampered or truncated download is rejected.
//
// Why download instead of build: `npx skills add` clones this repo and symlinks
// it into an agent; it never runs a build. Fetching a prebuilt, checksummed
// asset makes setup a single network step with no toolchain (no esbuild, no
// editor source) — see docs/agent-skill.md.
//
// Usage:
//   node scripts/fetch-engine.mjs            # download + verify -> lib/engine.mjs
//   node scripts/fetch-engine.mjs --check    # verify lib/engine.mjs matches the pin; else exit 1
//   node scripts/fetch-engine.mjs --force    # re-download even if a valid file exists
//
// Maintainers cutting a new editor release: bump ENGINE_VERSION + ENGINE_SHA256
// to the new asset (the release publishes a matching <asset>.sha256), then run
// this to refresh the committed pin.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT = join(ROOT, "lib", "engine.mjs");

// Pinned engine release. Keep in lockstep: the URL version and the checksum
// must both come from the same drawcms/drawcms release.
const ENGINE_VERSION = "0.17.2";
const ENGINE_SHA256 = "9e65e1de4318e53f23313b9bd2f93f50337615953cbd129e8464eefe49db05e7";
const ENGINE_URL = `https://github.com/drawcms/drawcms/releases/download/v${ENGINE_VERSION}/drawcms-engine-${ENGINE_VERSION}.mjs`;

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** True if lib/engine.mjs exists and matches the pinned checksum. */
function localMatchesPin() {
  if (!existsSync(OUT)) return false;
  return sha256(readFileSync(OUT)) === ENGINE_SHA256;
}

async function download(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`download failed: HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

const check = process.argv.includes("--check");
const force = process.argv.includes("--force");

if (check) {
  if (!existsSync(OUT)) {
    console.error(`lib/engine.mjs is missing. Run: npm run fetch-engine`);
    process.exit(1);
  }
  const actual = sha256(readFileSync(OUT));
  if (actual !== ENGINE_SHA256) {
    console.error(
      `lib/engine.mjs does not match the pinned engine ${ENGINE_VERSION}.\n` +
        `  expected sha256 ${ENGINE_SHA256}\n` +
        `  actual   sha256 ${actual}\n` +
        `Run: npm run fetch-engine --force`,
    );
    process.exit(1);
  }
  console.log(`lib/engine.mjs matches pinned engine ${ENGINE_VERSION}.`);
  process.exit(0);
}

if (localMatchesPin() && !force) {
  console.log(`lib/engine.mjs already matches engine ${ENGINE_VERSION} — nothing to do.`);
  process.exit(0);
}

const buf = await download(ENGINE_URL);
const actual = sha256(buf);
if (actual !== ENGINE_SHA256) {
  console.error(
    `Refusing to write engine: checksum mismatch for ${ENGINE_URL}\n` +
      `  expected sha256 ${ENGINE_SHA256}\n` +
      `  actual   sha256 ${actual}\n` +
      `The download may be corrupt or the pin is out of date.`,
  );
  process.exit(1);
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, buf);
console.log(`Wrote ${OUT} (${buf.length} bytes) — engine ${ENGINE_VERSION}, sha256 verified.`);
