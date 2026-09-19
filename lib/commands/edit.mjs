// `drawcms edit <name> <ops.json>` — apply an incremental batch of graph edits
// to a tracked diagram's local document, WITHOUT a full rebuild. This is the
// headless equivalent of WebMCP's drawcms_edit_diagram: a surgical add/update/
// delete of nodes and edges that preserves everything else — crucially the
// positions a human may have dragged in the editor, which a rebuild from a spec
// would discard.
//
// Use this to refine an existing diagram (a pulled document); use build+push to
// author one from scratch. After editing, validate and push as usual.

import { readFile, writeFile } from "node:fs/promises";
import { applyGraphEditOperations } from "../engine.mjs";
import { normalizeIssues, runGrammarValidation } from "../build.mjs";
import { readProjectConfig } from "../project.mjs";
import { documentPath } from "../docfile.mjs";
import { emit } from "../output.mjs";

const HELP = `drawcms edit <name> <ops.json> [--json]

Applies an incremental batch of operations to the tracked diagram <name>'s
local document (.drawcms/<name>.json), preserving untouched nodes/edges and
their positions. Author one from scratch with build+push instead.

<ops.json> shape:
  { "operations": [
      { "op": "addNode", "node": { "id": "cache", "data": { "label": "Redis", "type": "infra-redis" } } },
      { "op": "updateNode", "nodeId": "api", "dataPatch": { "label": "Gateway" } },
      { "op": "updateEdge", "edgeId": "edge-api-db-1", "label": "SQL (pooled)" },
      { "op": "deleteNode", "nodeId": "legacy" },
      { "op": "addEdge", "edge": { "id": "e-api-cache", "source": "api", "target": "cache" } },
      { "op": "deleteEdge", "edgeId": "edge-old-1" }
    ] }

Applies in array order as one batch. Re-run \`drawcms build\` after editing to
re-validate, then \`push\`. A non-zero exit is never success.`;

export async function run({ flags, positional }) {
  if (flags.help || positional.length !== 2) {
    process.stdout.write(HELP + "\n");
    process.exit(flags.help ? 0 : 1);
  }
  const [name, opsPath] = positional;

  const link = await readProjectConfig();
  if (!link) return fail(flags.json, "NOT_INITIALIZED", "Run `drawcms init` in this repo first.");
  if (!link.diagrams?.[name]) {
    return fail(flags.json, "UNKNOWN_DIAGRAM", `"${name}" is not a tracked diagram. Tracked: ${Object.keys(link.diagrams ?? {}).join(", ") || "(none)"}.`);
  }

  // Load the local document (a pulled cloud doc or a previously built one).
  let document;
  const docFile = documentPath(name);
  try {
    document = JSON.parse(await readFile(docFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return fail(flags.json, "NO_LOCAL_DOCUMENT", `No local ${docFile}. Run \`drawcms pull ${name}\` first, or author it with build.`);
    }
    return fail(flags.json, "DOCUMENT_UNREADABLE", `${docFile} is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(document.nodes)) {
    return fail(flags.json, "NOT_A_DOCUMENT", `${docFile} does not look like a built document (no nodes array). Edit operates on a pulled/built document, not a raw authoring spec.`);
  }

  // Load and shape-check the operations.
  let ops;
  try {
    const parsed = JSON.parse(await readFile(opsPath, "utf8"));
    ops = parsed.operations ?? parsed;
  } catch (error) {
    return fail(flags.json, error.code === "ENOENT" ? "OPS_NOT_FOUND" : "OPS_INVALID_JSON", `${opsPath}: ${error.message}`);
  }
  if (!Array.isArray(ops) || ops.length === 0) {
    return fail(flags.json, "NO_OPERATIONS", "Expected a non-empty `operations` array.");
  }

  // Validate ids the operations reference against the current document, so a
  // typo fails loudly instead of silently no-op'ing (WebMCP validates ids too).
  const nodeIds = new Set(document.nodes.map((n) => n.id));
  const edgeIds = new Set((document.edges ?? []).map((e) => e.id));
  const idProblems = [];
  for (const [i, op] of ops.entries()) {
    const at = `operations[${i}]`;
    if (op.op === "updateNode" || op.op === "deleteNode") {
      if (!nodeIds.has(op.nodeId)) idProblems.push({ code: "UNKNOWN_NODE", path: at, message: `${op.op} references node "${op.nodeId}" not in the diagram.` });
    } else if (op.op === "updateEdge" || op.op === "deleteEdge") {
      if (!edgeIds.has(op.edgeId)) idProblems.push({ code: "UNKNOWN_EDGE", path: at, message: `${op.op} references edge "${op.edgeId}" not in the diagram.` });
    } else if (op.op === "addNode") {
      if (op.node?.id) nodeIds.add(op.node.id); // available to later ops in the batch
    } else if (op.op === "addEdge") {
      if (op.edge?.id) edgeIds.add(op.edge.id);
    } else {
      idProblems.push({ code: "UNKNOWN_OP", path: at, message: `Unknown operation "${op.op}".` });
    }
  }
  if (idProblems.length) return fail(flags.json, "edit", idProblems);

  // Apply as one batch — pure, editor-independent, preserves untouched state.
  // applyGraphEditOperations works on an editor snapshot ({nodes, edges}) and
  // drops the rest of the document, so merge the result back over the original
  // to keep meta, motion/story, schemaVersion, and any other fields intact.
  let editedSnapshot;
  try {
    editedSnapshot = applyGraphEditOperations(document, ops);
  } catch (error) {
    return fail(flags.json, "apply", normalizeIssues(error));
  }
  const edited = {
    ...document,
    nodes: editedSnapshot.nodes,
    edges: editedSnapshot.edges,
  };

  // Re-validate the resulting document and surface grammar findings. Pass the
  // document's own diagram type so the validator does not have to re-infer it.
  const validation = runGrammarValidation(edited, edited.meta?.diagramType);

  await writeFile(docFile, JSON.stringify(edited, null, 2) + "\n");

  emit(
    {
      ok: true,
      command: "edit",
      diagram: name,
      applied: ops.length,
      summary: { nodes: edited.nodes.length, edges: (edited.edges ?? []).length, warnings: validation.issues?.length ?? 0 },
      warnings: validation.issues ?? [],
      render() {
        process.stdout.write(`edited ${name}: applied ${ops.length} op(s) -> ${edited.nodes.length} nodes, ${(edited.edges ?? []).length} edges, ${validation.issues?.length ?? 0} warning(s)\n`);
        for (const w of (validation.issues ?? []).slice(0, 20)) {
          process.stdout.write(`  ! ${w.code}${w.elementId ? ` (${w.elementId})` : ""}: ${w.message}\n`);
        }
        process.stdout.write(`Wrote ${docFile}. Run \`drawcms push ${name}\` to sync.\n`);
      },
    },
    { json: flags.json },
  );
  process.exit(0);
}

function fail(json, stageOrCode, issuesOrMessage) {
  const isList = Array.isArray(issuesOrMessage);
  emit(
    {
      ok: false,
      command: "edit",
      ...(isList ? { stage: stageOrCode, issues: issuesOrMessage } : { error: { code: stageOrCode, message: issuesOrMessage } }),
      render() {
        if (isList) {
          process.stderr.write(`edit failed (${stageOrCode}):\n`);
          for (const i of issuesOrMessage) process.stderr.write(`  ✗ ${i.code}${i.path ? ` at ${i.path}` : ""}: ${i.message}\n`);
        } else {
          process.stderr.write(`edit failed (${stageOrCode}): ${issuesOrMessage}\n`);
        }
      },
    },
    { json },
  );
  process.exit(1);
}
