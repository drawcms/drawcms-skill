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
