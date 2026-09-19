#!/usr/bin/env node
// drawcms — turn a code repository into maintained DrawCMS diagrams synced to a
// cloud project. Git-like command surface: login, init, pull, push, status,
// diff. This file is a thin dispatcher; each command lives in ../lib/commands.

import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { parseFlags } from "../lib/output.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/** Commands that load the bundled diagram engine. The bundle is a prebuilt
 * release asset fetched by `npm run fetch-engine` and gitignored, so a fresh
 * checkout has none until that runs — without this preflight those commands
 * fail with a bare module-not-found. */
const NEEDS_ENGINE = new Set(["build", "push", "recommend", "edit", "grammar", "local"]);

const COMMANDS = {
  doctor: () => import("../lib/commands/doctor.mjs"),
  build: () => import("../lib/commands/build.mjs"),
  local: () => import("../lib/commands/local.mjs"),
  edit: () => import("../lib/commands/edit.mjs"),
  recommend: () => import("../lib/commands/recommend.mjs"),
  grammar: () => import("../lib/commands/grammar.mjs"),
  login: () => import("../lib/commands/login.mjs"),
  init: () => import("../lib/commands/init.mjs"),
  pull: () => import("../lib/commands/pull.mjs"),
  push: () => import("../lib/commands/push.mjs"),
  status: () => import("../lib/commands/status.mjs"),
  diff: () => import("../lib/commands/diff.mjs"),
};

const USAGE = `drawcms — repo-to-DrawCMS diagram sync

Usage: drawcms <command> [args] [--json]

Commands:
  doctor                       Check the local environment and diagram engine.
  build <type> <spec.json>     Build + validate a diagram spec headlessly.
                               <type>: architecture | flowchart | sequence | data-flow | lifecycle
  local [<type>] <spec|name>   Build for a self-hosted OSS editor (no cloud); writes a
                               loadable document + load instructions.
  edit <name> <ops.json>       Apply incremental edits to a tracked diagram (preserves positions).
  recommend <entities.json>    Suggest the best element type per entity (brand marks for named tech).
  grammar [id]                 Query the visual grammar: element/motion purpose and usage.
  login                        Sign in via the browser (device flow); stores a token.
  init [options]               Bind this repo to a DrawCMS project (writes .drawcms/config.json).
  pull [name] [--force]        Fetch diagram document(s) from the cloud into .drawcms/.
  push [name] [--force]        Validate and save local diagram document(s) to the cloud.
  status                       Show local edits and whether diagrams lag behind the latest commit.
  diff [name] [--against-cloud]  Show code changes since last sync, locally modified diagrams,
                               and (with --against-cloud) a node/edge delta vs the cloud.

Run "drawcms <command> --help" for details.`;

async function main() {
  const [, , command, ...rest] = process.argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE + "\n");
    process.exit(command ? 0 : 1);
  }

  const loader = COMMANDS[command];
  if (!loader) {
    process.stderr.write(`Unknown command: ${command}\n\n${USAGE}\n`);
    process.exit(1);
  }

  const { flags, positional } = parseFlags(rest);

  if (NEEDS_ENGINE.has(command) && !existsSync(join(ROOT, "lib", "engine.mjs"))) {
    const payload = {
      ok: false,
      command,
      error: {
        code: "ENGINE_MISSING",
        message:
          "The diagram engine bundle (lib/engine.mjs) is missing. Run `npm run fetch-engine` in the skill folder, then retry.",
      },
    };
    process.stdout.write(
      flags.json ? JSON.stringify(payload) + "\n" : `error: ${payload.error.message}\n`,
    );
    process.exit(1);
  }

  const mod = await loader();
  await mod.run({ flags, positional, root: ROOT });
}

main().catch((error) => {
  // Last-resort guard: never crash with a bare stack in --json contexts. A
  // coded error (e.g. CONFIG_CORRUPT) keeps its code so the message stays
  // actionable instead of collapsing to UNEXPECTED.
  const json = process.argv.includes("--json");
  const payload = {
    ok: false,
    error: { code: error?.code ?? "UNEXPECTED", message: error?.message ?? String(error) },
  };
  process.stdout.write(json ? JSON.stringify(payload) + "\n" : `error: ${payload.error.message}\n`);
  process.exit(1);
});
