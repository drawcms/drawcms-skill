// `drawcms grammar [id]` — query the DrawCMS visual grammar: what an element or
// motion preset is for, when to use it, and what to avoid. Headless equivalent
// of WebMCP's drawcms_get_visual_grammar. Read-only, no network.
//
//   drawcms grammar                 list every element + motion id
//   drawcms grammar infra-redis     describe one element
//   drawcms grammar "Data Flow"     describe one motion preset

import {
  getVisualElementGrammar,
  getVisualMotionGrammar,
  VISUAL_ELEMENT_REGISTRY,
  VISUAL_MOTION_REGISTRY,
} from "../engine.mjs";
import { emit } from "../output.mjs";

const HELP = `drawcms grammar [id] [--json]

Query the DrawCMS visual grammar — the dictionary of elements and motion
presets, each with its purpose, typical use, and what to avoid.

  (no id)   List every element and motion id.
  <id>      Describe one element (e.g. infra-redis, arch-backend) or motion
            preset (e.g. "Data Flow", "Pulse Node").`;

export async function run({ flags, positional }) {
  if (flags.help) {
    process.stdout.write(HELP + "\n");
    process.exit(0);
  }

  const elements = Array.isArray(VISUAL_ELEMENT_REGISTRY) ? VISUAL_ELEMENT_REGISTRY : [];
  const motions = Array.isArray(VISUAL_MOTION_REGISTRY) ? VISUAL_MOTION_REGISTRY : [];

  // No id -> index of everything.
  if (positional.length === 0) {
    const elementIds = elements.map((e) => e.id).sort();
    const motionIds = motions.map((m) => m.id).sort();
    emit(
      {
        ok: true,
        command: "grammar",
        elementCount: elementIds.length,
        motionCount: motionIds.length,
        elements: elementIds,
        motions: motionIds,
        render() {
          process.stdout.write(`elements (${elementIds.length}):\n  ${elementIds.join(", ")}\n\n`);
          process.stdout.write(`motion presets (${motionIds.length}):\n  ${motionIds.join(", ")}\n`);
          process.stdout.write(`\nQuery one: drawcms grammar <id>\n`);
        },
      },
      { json: flags.json },
    );
    process.exit(0);
  }

  const id = positional[0];
  const element = getVisualElementGrammar(id);
  const motion = getVisualMotionGrammar(id);
  const entry = element ?? motion;

  if (!entry) {
    emit(
      {
        ok: false,
        command: "grammar",
        error: {
          code: "UNKNOWN_ID",
          message: `"${id}" is not a known element or motion preset. Run \`drawcms grammar\` to list them.`,
        },
        render() {
          process.stderr.write(`grammar: unknown id "${id}". Run \`drawcms grammar\` to list ids.\n`);
        },
      },
      { json: flags.json },
    );
    process.exit(1);
  }

  emit(
    {
      ok: true,
      command: "grammar",
      kind: element ? "element" : "motion",
      entry,
      render() {
        process.stdout.write(`${entry.id}${entry.title ? ` — ${entry.title}` : ""} (${element ? "element" : "motion"})\n`);
        if (entry.purpose) process.stdout.write(`  purpose: ${entry.purpose}\n`);
        if (entry.mostlyUsedFor) process.stdout.write(`  use for: ${entry.mostlyUsedFor.join(", ")}\n`);
        if (entry.avoidFor) process.stdout.write(`  avoid:   ${entry.avoidFor.join(", ")}\n`);
        if (entry.suitableMotionPresets) process.stdout.write(`  motion:  ${entry.suitableMotionPresets.join(", ")}\n`);
        if (entry.diagramTypes) process.stdout.write(`  types:   ${entry.diagramTypes.join(", ")}\n`);
        if (entry.directionality) process.stdout.write(`  direction: ${entry.directionality}\n`);
      },
    },
    { json: flags.json },
  );
  process.exit(0);
}
