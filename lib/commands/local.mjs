// `drawcms local <type> <spec.json>` — build a diagram for a SELF-HOSTED OSS
// editor, with no cloud account. The open-source DrawCMS editor is a local-only
// canvas: it has no login, no projects, and no server API — it persists a
// single document to the browser's localStorage (key "drawcms.document.v1") and
// exposes WebMCP. So the cloud sync commands (login/init/pull/push) do not
// apply. This command covers the cloud-less path end to end:
//
//   1. build + validate the spec through the engine (identical to `drawcms
//      build`, fully offline);
//   2. write the built DrawCMSDocument to a file the user can open/import; and
//   3. print exactly how to load it into a self-hosted editor — either by
//      importing the file, or by seeding localStorage.
//
// It is deliberately "limited": no naming policy, no version tracking, no
// network. What the OSS editor can do, this supports; what only the cloud can
// do (share links, projects, autosave), it does not pretend to.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { emit } from "../output.mjs";
import {
  buildDocument,
  toBuildSpec,
  readSpecFile,
  resolveDiagramType,
  PRIMARY_DIAGRAM_TYPES,
} from "../build.mjs";
import { readProjectConfig, PROJECT_DIR } from "../project.mjs";
import { documentPath } from "../docfile.mjs";
import { assertSafeOrigin } from "../config.mjs";

// The localStorage key the OSS editor's local-storage persistence adapter reads
// on load. Seeding this key with a built document makes the editor open it.
const OSS_STORAGE_KEY = "drawcms.document.v1";
const DEFAULT_OSS_ORIGIN = "http://localhost:3002";

const HELP = `drawcms local [<type>] <spec.json | name> [--out <file>] [--editor <url>] [--seed] [--animate] [--json]

Builds a diagram for a SELF-HOSTED (open-source) DrawCMS editor — no cloud
account, no login/init/push. The OSS editor is a local-only canvas that stores
one document in the browser (localStorage). This validates the spec through the
engine and produces a document you load into that editor.

  <type>          ${PRIMARY_DIAGRAM_TYPES.join(" | ")} (or omit and set diagramType in the spec).
  <spec.json>     Path to an authoring spec, OR the logical name of a tracked
                  diagram in .drawcms/ (its .drawcms/<name>.json is used).
  --out <file>    Where to write the built document (default: alongside the
                  input, or .drawcms/<name>.local.json for a tracked name).
  --editor <url>  Self-hosted editor origin for the load hint (default:
                  ${DEFAULT_OSS_ORIGIN}; must be https or localhost).
  --seed          Also print a localStorage seed snippet that opens the document
                  directly in the editor (key "${OSS_STORAGE_KEY}").
  --animate       Keep engine-derived motion (default: static, story preserved).

Cloud features (share links, projects, autosave, version history) are not
available against a self-hosted editor. A non-zero exit is never success.`;

export async function run({ flags, positional }) {
  if (flags.help) {
    process.stdout.write(HELP + "\n");
    process.exit(0);
  }

  // Resolve the spec source: "local <type> <arg>" or "local <arg>".
  let cliType;
  let arg;
  if (positional.length === 2) {
    [cliType, arg] = positional;
  } else if (positional.length === 1) {
    [arg] = positional;
  } else {
    return fail(flags.json, "USAGE", "Expected: local [<type>] <spec.json | tracked-name>");
  }
  if (cliType && !PRIMARY_DIAGRAM_TYPES.includes(cliType)) {
    return fail(flags.json, "UNKNOWN_TYPE", `Unknown type "${cliType}". Use one of: ${PRIMARY_DIAGRAM_TYPES.join(", ")}.`);
  }

  // The editor origin is only used to compose a hint URL, but validate it so we
  // never print a hint pointing somewhere unsafe (e.g. a file: or http host).
  const editorOrigin = (flags.editor || DEFAULT_OSS_ORIGIN).replace(/\/+$/, "");
  const safe = assertSafeOrigin(editorOrigin);
  if (!safe.ok) return fail(flags.json, safe.code, safe.message);

  // Is `arg` a tracked diagram name, or a spec file path? Prefer a tracked name
  // when the repo is linked and the name matches, else treat it as a path.
  const link = await readProjectConfig();
  const tracked = link?.diagrams?.[arg] ? arg : null;
  const specPath = tracked ? documentPath(tracked) : arg;

  const read = await readSpecFile(specPath);
  if (!read.ok) {
    return fail(
      flags.json,
      read.issues?.[0]?.code ?? "READ_FAILED",
      `${read.issues?.[0]?.message ?? "could not read"} (${specPath})` +
        (tracked ? "" : " — pass a spec file path or a tracked diagram name."),
    );
  }

  // A tracked file may be a full built/pulled document; normalize either shape.
  const rawSpec = toBuildSpec(read.spec);
  const typeResult = resolveDiagramType(cliType, rawSpec);
  if (!typeResult.ok) return failIssues(flags.json, typeResult.issues);
  const spec = { ...rawSpec };
  if (typeResult.diagramType) spec.diagramType = typeResult.diagramType;

  const built = buildDocument(spec, { animate: flags.animate === true });
  if (!built.ok) return failIssues(flags.json, built.issues, built.stage);

  const { document, validation, motion } = built;
  const warnings = Array.isArray(validation?.issues) ? validation.issues : [];

  // Decide the output path.
  const outPath =
    flags.out ||
    (tracked
      ? join(PROJECT_DIR, `${tracked}.local.json`)
      : specPath.replace(/\.json$/i, "") + ".built.json");
  await writeFile(outPath, JSON.stringify(document, null, 2) + "\n");

  const seedSnippet = flags.seed
    ? `localStorage.setItem(${JSON.stringify(OSS_STORAGE_KEY)}, ${JSON.stringify(
        JSON.stringify(document),
      )}); location.reload();`
    : null;

  const storySteps =
    document.motion?.story?.scenes?.reduce((n, s) => n + (s.steps?.length ?? 0), 0) ?? 0;

  emit(
    {
      ok: true,
      command: "local",
      mode: "self-hosted",
      out: outPath,
      editor: editorOrigin,
      motion,
      summary: {
        nodes: document.nodes.length,
        edges: document.edges.length,
        storySteps,
        warnings: warnings.length,
      },
      warnings,
      ...(seedSnippet ? { seedSnippet } : {}),
      // The document itself only in JSON mode, so an agent can capture it.
      document: flags.json ? document : undefined,
      render() {
        process.stdout.write(
          `built (self-hosted): ${document.nodes.length} nodes, ${document.edges.length} edges, ` +
            `${storySteps} story step(s), ${motion}, ${warnings.length} warning(s)\n` +
            `wrote ${outPath}\n`,
        );
        for (const w of warnings.slice(0, 20)) {
          process.stdout.write(`  ! ${w.code ?? "WARN"}${w.elementId ? ` (${w.elementId})` : ""}: ${w.message ?? ""}\n`);
        }
        process.stdout.write(
          `\nLoad it into your self-hosted OSS editor (${editorOrigin}):\n` +
            `  • Open the editor and use its Import to open ${outPath}, or\n` +
            (seedSnippet
              ? `  • Paste this in the editor tab's DevTools console to open it directly:\n      ${seedSnippet}\n`
              : `  • Re-run with --seed to get a one-line localStorage snippet that opens it directly.\n`) +
            `Note: this is local-only. Share links, projects, and autosave are Cloud features.\n`,
        );
      },
    },
    { json: flags.json },
  );
  process.exit(0);
}

function fail(json, code, message) {
  emit(
    {
      ok: false,
      command: "local",
      error: { code, message },
      render() {
        process.stderr.write(`local failed (${code}): ${message}\n`);
      },
    },
    { json },
  );
  process.exit(1);
}

function failIssues(json, issues, stage = "build") {
  emit(
    {
      ok: false,
      command: "local",
      stage,
      issues: issues ?? [],
      render() {
        process.stderr.write(`local failed (${stage}):\n`);
        for (const i of issues ?? []) {
          process.stderr.write(`  ✗ ${i.code}${i.path ? ` at ${i.path}` : ""}: ${i.message}\n`);
        }
      },
    },
    { json },
  );
  process.exit(1);
}
