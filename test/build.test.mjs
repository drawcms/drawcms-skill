import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  buildDocument,
  resolveDiagramType,
  normalizeIssues,
  PRIMARY_DIAGRAM_TYPES,
} from "../lib/build.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = resolve(HERE, "..", "examples");

function example(name) {
  return JSON.parse(readFileSync(join(EXAMPLES, `${name}.json`), "utf8"));
}

for (const type of PRIMARY_DIAGRAM_TYPES) {
  test(`builds the ${type} example into a validated document`, () => {
    const spec = example(type);
    const result = buildDocument(spec);
    assert.equal(result.ok, true, `expected ${type} example to build`);
    assert.ok(result.document.nodes.length >= 2, "document should have nodes");
    assert.equal(result.document.meta.diagramType, type);
    assert.equal(typeof result.validation, "object");
    assert.ok(Array.isArray(result.validation.issues), "validation should carry an issues array");
  });
}

test("rejects an unknown node type with structured issues", () => {
  const result = buildDocument({
    diagramType: "architecture",
    nodes: [{ id: "a", label: "X", type: "not-a-real-type" }],
    edges: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "build");
  assert.ok(result.issues.length >= 1);
  assert.ok(
    result.issues.some((i) => i.code === "invalid_enum_value" || i.code === "ENGINE_ERROR"),
    "should surface a structured enum/engine issue",
  );
});

test("rejects an edge referencing an unknown node", () => {
  const result = buildDocument({
    diagramType: "flowchart",
    nodes: [{ id: "a", label: "A", type: "process" }],
    edges: [{ source: "a", target: "ghost" }],
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.length >= 1);
});

test("resolveDiagramType flags a CLI/spec conflict", () => {
  const res = resolveDiagramType("architecture", { diagramType: "sequence" });
  assert.equal(res.ok, false);
  assert.equal(res.issues[0].code, "DIAGRAM_TYPE_CONFLICT");
});

test("resolveDiagramType prefers the CLI type when spec omits it", () => {
  const res = resolveDiagramType("lifecycle", { nodes: [] });
  assert.equal(res.ok, true);
  assert.equal(res.diagramType, "lifecycle");
});

test("normalizeIssues wraps a plain Error as ENGINE_ERROR", () => {
  const issues = normalizeIssues(new Error("boom"));
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, "ENGINE_ERROR");
  assert.match(issues[0].message, /boom/);
});

test("toBuildSpec lifts diagramType and name out of a built/pulled document's meta", async () => {
  const { toBuildSpec } = await import("../lib/build.mjs");
  const spec = toBuildSpec({
    meta: { name: "Arch", diagramType: "architecture" },
    nodes: [{ id: "a", label: "X", type: "arch-backend" }],
    edges: [],
  });
  assert.equal("meta" in spec, false);
  assert.equal(spec.diagramType, "architecture");
  assert.equal(spec.name, "Arch");
  assert.equal(spec.nodes.length, 1);
});

test("toBuildSpec passes an authoring spec (no meta) through unchanged", async () => {
  const { toBuildSpec } = await import("../lib/build.mjs");
  const input = { diagramType: "flowchart", nodes: [], edges: [] };
  assert.deepEqual(toBuildSpec(input), input);
});


// Regression: `push` writes a built document back to `.drawcms/<name>.json`, so
// the CLI must be able to read its own output. It could not — toBuildSpec only
// stripped `meta` and left nodes/edges in document shape (`data.label`,
// `type: "customShape"`, routing), which the strict input schema rejects with
// `invalid_type nodes.0.label Required`. That broke every second push of a
// diagram and the whole documented pull → edit → push loop.
//
// The older toBuildSpec tests above hid this because their fixture documents had
// spec-shaped nodes, which a real build never produces.
for (const type of PRIMARY_DIAGRAM_TYPES) {
  test(`a built ${type} document round-trips back through toBuildSpec`, async () => {
    const { toBuildSpec } = await import("../lib/build.mjs");
    const first = buildDocument(example(type));
    assert.equal(first.ok, true, `expected ${type} example to build`);

    const respec = toBuildSpec(structuredClone(first.document));
    const second = buildDocument(respec);
    assert.equal(
      second.ok,
      true,
      `re-building a ${type} document failed: ${JSON.stringify(second.issues?.slice(0, 2))}`,
    );

    // The rebuild must describe the same diagram, not merely validate.
    const shape = (doc) => ({
      name: doc.meta.name,
      diagramType: doc.meta.diagramType,
      nodes: doc.nodes.map((n) => ({
        id: n.id,
        label: n.data.label,
        type: n.data.type,
        position: n.position,
        preset: n.data.preset ?? null,
      })),
      edges: doc.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.data.label ?? null,
        sequenceType: e.data.sequenceType ?? null,
        preset: e.data.preset ?? null,
        loop: e.data.motionLoop ?? null,
      })),
      steps: (doc.motion?.story?.scenes ?? []).flatMap((scene) =>
        (scene.steps ?? []).map((step) => ({
          title: step.title,
          targets: (step.targets ?? []).map((t) => `${t.targetKind}:${t.targetId}`),
        })),
      ),
    });
    assert.deepEqual(shape(second.document), shape(first.document));
  });
}

test("toBuildSpec drops engine-derived detail the strict input schema rejects", async () => {
  const { toBuildSpec } = await import("../lib/build.mjs");
  const built = buildDocument(example("architecture"));
  const spec = toBuildSpec(structuredClone(built.document));

  for (const key of ["meta", "schemaVersion", "canvas", "assets", "motion"]) {
    assert.equal(key in spec, false, `${key} must not survive into the input spec`);
  }
  for (const node of spec.nodes) {
    assert.deepEqual(
      Object.keys(node).filter((k) => !["id", "label", "type", "position", "motion"].includes(k)),
      [],
      "node carries a key the input schema would reject",
    );
  }
  for (const edge of spec.edges) {
    assert.deepEqual(
      Object.keys(edge).filter(
        (k) => !["id", "source", "target", "label", "type", "motion"].includes(k),
      ),
      [],
      "edge carries a key the input schema would reject",
    );
  }
});

test("toBuildSpec keeps node positions so a hand-arranged layout survives a round trip", async () => {
  const { toBuildSpec } = await import("../lib/build.mjs");
  const built = buildDocument({
    name: "Layout",
    diagramType: "architecture",
    nodes: [
      { id: "a", label: "A", type: "arch-frontend", position: { x: 640, y: 480 } },
      { id: "b", label: "B", type: "arch-backend" },
    ],
    edges: [{ source: "a", target: "b" }],
  });
  const spec = toBuildSpec(structuredClone(built.document));
  assert.deepEqual(spec.nodes.find((n) => n.id === "a").position, { x: 640, y: 480 });
});

test("toBuildSpec recovers the walkthrough from a compiled story", async () => {
  const { toBuildSpec } = await import("../lib/build.mjs");
  const built = buildDocument({
    name: "Story",
    diagramType: "architecture",
    nodes: [
      { id: "a", label: "A", type: "arch-frontend" },
      { id: "b", label: "B", type: "arch-backend" },
    ],
    edges: [{ source: "a", target: "b", label: "calls" }],
    beats: [{ title: "A calls B", nodeIds: ["a", "b"], edgeIds: ["a>b"], kind: "request" }],
  });
  const spec = toBuildSpec(structuredClone(built.document));
  // A document has no `beats` — the walkthrough lives in the compiled story, and
  // dropping it would silently discard the animation on the next push.
  assert.ok(spec.story?.scenes?.length, "story should be carried over");
  assert.equal(spec.story.scenes[0].steps[0].title, "A calls B");
  const rebuilt = buildDocument(spec);
  assert.equal(rebuilt.ok, true);
  assert.equal(rebuilt.document.motion.story.scenes[0].steps[0].title, "A calls B");
});
