// `drawcms recommend <entities.json>` — map the entities you identified in the
// repo to the closest DrawCMS element, so a named technology renders as its
// brand mark (Redis -> infra-redis) instead of a generic box. Read-only, no
// network.
//
// This is a SUGGESTION layer, not an authority: the engine matches on the words
// in each label with no awareness of the repo, and it only recognizes the 10
// infrastructure brands (the aws-*/gcp-*/azure- cloud logos are chosen directly
// from references/vocabulary.md, not here). Confirm every suggestion against the
// code before authoring — a brand icon the code does not justify is worse than
// a correct generic box.

import { readSpecFile } from "../build.mjs";
import { recommendVisualGrammar, VISUAL_DIAGRAM_TYPES } from "../engine.mjs";
import { emit } from "../output.mjs";

const HELP = `drawcms recommend <entities.json> [--json]

Suggests the best element type for each entity you identified in the repo.
Input file shape:
  {
    "diagramType": "architecture",
    "entities": [
      { "id": "redis", "role": "datastore", "label": "Redis cache" },
      { "id": "api",   "role": "component", "label": "Express API" }
    ]
  }

role: component | datastore | actor | external | boundary (best-effort hints).

Output pairs each entity id with a suggested element id. Suggestions are
label-keyword matches with no repo awareness and cover only the infra-* brands;
confirm each against the code, and pick cloud logos (aws-*/gcp-*/azure-*)
directly from references/vocabulary.md. A non-zero exit is never success.`;

export async function run({ flags, positional }) {
  if (flags.help || positional.length !== 1) {
    process.stdout.write(HELP + "\n");
    process.exit(flags.help ? 0 : 1);
  }

  const read = await readSpecFile(positional[0]);
  if (!read.ok) {
    return fail(flags.json, read.stage, read.issues);
  }

  const input = read.spec;
  if (!input || typeof input !== "object" || !Array.isArray(input.entities)) {
    return fail(flags.json, "input", [
      { code: "INVALID_INPUT", message: "Expected an object with an `entities` array." },
    ]);
  }

  const diagramType = input.diagramType ?? "architecture";
  if (!VISUAL_DIAGRAM_TYPES.includes(diagramType)) {
    return fail(flags.json, "input", [
      {
        code: "UNKNOWN_TYPE",
        path: "diagramType",
        message: `Unknown diagramType "${diagramType}".`,
      },
    ]);
  }

  // The engine keys suggestions off entity.id, so ensure each entity has one
  // (fall back to its array index) and remember the label for reporting.
  const entities = input.entities.map((e, i) => ({
    id: e.id ?? String(i),
    role: e.role,
    label: e.label ?? "",
  }));
  const labelById = new Map(entities.map((e) => [e.id, e.label]));

  let report;
  try {
    report = recommendVisualGrammar({
      diagramType,
      entities,
      ...(Array.isArray(input.relationships) ? { relationships: input.relationships } : {}),
    });
  } catch (error) {
    return fail(flags.json, "engine", [{ code: "ENGINE_ERROR", message: error.message }]);
  }

  const suggestions = (report.elements ?? []).map((el) => ({
    id: el.entityId,
    label: labelById.get(el.entityId) ?? null,
    element: el.elementId,
    title: el.elementTitle,
    branded: /^(infra|aws|gcp|azure)-/.test(el.elementId),
    rationale: el.rationale,
  }));

  emit(
    {
      ok: true,
      command: "recommend",
      diagramType,
      // Surface the engine's layout note; it is useful authoring context.
      note: "Suggestions match on label keywords with no repo awareness and cover only infra-* brands. Confirm each against the code; a brand the code does not use is worse than a generic box.",
      suggestions,
      render() {
        for (const s of suggestions) {
          const mark = s.branded ? "◆" : "·";
          process.stdout.write(
            `${mark} ${(s.label ?? s.id).padEnd(28)} -> ${s.element}${s.branded ? "  (brand — confirm the code uses it)" : ""}\n`,
          );
        }
        process.stdout.write(
          "\nConfirm each suggestion against the code before authoring. For cloud services, pick aws-*/gcp-*/azure-* from references/vocabulary.md.\n",
        );
      },
    },
    { json: flags.json },
  );
  process.exit(0);
}

function fail(json, stage, issues) {
  emit(
    {
      ok: false,
      command: "recommend",
      stage,
      issues,
      render() {
        process.stderr.write(`recommend failed (${stage}):\n`);
        for (const i of issues) process.stderr.write(`  ✗ ${i.code}: ${i.message}\n`);
      },
    },
    { json },
  );
  process.exit(1);
}
