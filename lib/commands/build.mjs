// `drawcms build <type> <spec.json>` — deterministic build + validate of an
// agent-authored diagram spec. Prints a machine-readable receipt with --json.
// Exit code is the contract: 0 only when a document was built. Grammar warnings
// do not fail the build but are always reported so the agent can resolve them.

import {
  buildDocument,
  readSpecFile,
  resolveDiagramType,
  toBuildSpec,
  PRIMARY_DIAGRAM_TYPES,
} from "../build.mjs";
import { emit } from "../output.mjs";

const HELP = `drawcms build <type> <spec.json> [--json] [--out <file>] [--static]

<type>: ${PRIMARY_DIAGRAM_TYPES.join(" | ")}  (or omit and set diagramType in the spec)

Builds and validates the spec headlessly using the DrawCMS engine. Any scene
story (from beats or an explicit story) is preserved. By default the result is
ANIMATED — the engine derives motion for the elements each step touches so the
diagram plays out of the box. Pass --static for a still diagram (story kept,
element motion stripped). Motion you set explicitly on a node/edge is always kept.
  --out <file>   Write the built document JSON to <file> (default: stdout summary only).
  --static       Strip engine-derived motion (default: animated).
  --json         Emit a single JSON receipt to stdout.

Exit code 0 means a document was built. A non-zero exit is never success.`;

export async function run({ flags, positional }) {
  if (flags.help) {
    process.stdout.write(HELP + "\n");
    process.exit(0);
  }

  // Accept either "build <type> <file>" or "build <file>" (type from spec).
  let cliType;
  let specPath;
  if (positional.length === 2) {
    [cliType, specPath] = positional;
  } else if (positional.length === 1) {
    [specPath] = positional;
  } else {
    emit(
      {
        ok: false,
        command: "build",
        stage: "args",
        issues: [{ code: "USAGE", message: "Expected: build <type> <spec.json> or build <spec.json>" }],
        render() {
          process.stderr.write(HELP + "\n");
        },
      },
      { json: flags.json },
    );
    process.exit(1);
  }

  if (cliType && !PRIMARY_DIAGRAM_TYPES.includes(cliType)) {
    emit(
      {
        ok: false,
        command: "build",
        stage: "args",
        issues: [
          {
            code: "UNKNOWN_TYPE",
            path: "type",
            message: `Unknown type "${cliType}". Use one of: ${PRIMARY_DIAGRAM_TYPES.join(", ")}.`,
          },
        ],
        render() {
          process.stderr.write(`error: unknown type "${cliType}"\n`);
        },
      },
      { json: flags.json },
    );
    process.exit(1);
  }

  const read = await readSpecFile(specPath);
  if (!read.ok) {
    emitFailure(read, flags.json);
    return;
  }

  // Accept either an authoring spec or a built/pulled document, matching `local`
  // and `push`. Without this, `build` could not validate the very file `push`
  // writes to `.drawcms/<name>.json`, so "validate before you claim anything"
  // was impossible on a tracked diagram.
  const rawSpec = toBuildSpec(read.spec);

  const typeResult = resolveDiagramType(cliType, rawSpec);
  if (!typeResult.ok) {
    emitFailure({ stage: "type", issues: typeResult.issues }, flags.json);
    return;
  }

  const spec = { ...rawSpec };
  if (typeResult.diagramType) spec.diagramType = typeResult.diagramType;

  const result = buildDocument(spec, { static: flags.static === true });
  if (!result.ok) {
    emitFailure(result, flags.json);
    return;
  }

  const { document, validation, motion } = result;
  const warnings = Array.isArray(validation?.issues) ? validation.issues : [];
  const storySteps =
    document.motion?.story?.scenes?.reduce((n, s) => n + (s.steps?.length ?? 0), 0) ?? 0;

  if (flags.out) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(flags.out, JSON.stringify(document, null, 2));
  }

  emit(
    {
      ok: true,
      command: "build",
      diagramType: document.meta?.diagramType ?? typeResult.diagramType ?? null,
      motion,
      summary: {
        nodes: document.nodes.length,
        edges: document.edges.length,
        storySteps,
        warnings: warnings.length,
      },
      warnings,
      ...(flags.out ? { out: flags.out } : {}),
      // Include the document only in JSON mode so an agent can capture it; the
      // human summary stays terse.
      document: flags.json ? document : undefined,
      render() {
        process.stdout.write(
          `built ${document.meta?.diagramType ?? "?"}: ${document.nodes.length} nodes, ` +
            `${document.edges.length} edges, ${storySteps} story step(s), ${motion}, ${warnings.length} warning(s)\n`,
        );
        for (const w of warnings.slice(0, 20)) {
          process.stdout.write(`  ! ${w.code ?? "WARN"}${w.subject ? ` (${w.subject})` : ""}: ${w.message ?? ""}\n`);
        }
        if (flags.out) process.stdout.write(`wrote ${flags.out}\n`);
      },
    },
    { json: flags.json },
  );
  process.exit(0);
}

function emitFailure(result, json) {
  emit(
    {
      ok: false,
      command: "build",
      stage: result.stage ?? "build",
      issues: result.issues ?? [],
      render() {
        process.stderr.write(`build failed (${result.stage ?? "build"}):\n`);
        for (const issue of result.issues ?? []) {
          const where = issue.path ? ` at ${issue.path}` : "";
          const got = issue.received !== undefined ? ` (received: ${JSON.stringify(issue.received)})` : "";
          process.stderr.write(`  ✗ ${issue.code}${where}: ${issue.message}${got}\n`);
        }
      },
    },
    { json },
  );
  process.exit(1);
}
