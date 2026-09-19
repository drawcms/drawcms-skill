import { test } from "node:test";
import assert from "node:assert/strict";
import { diffDocuments, renderDocDelta } from "../lib/docdiff.mjs";

function doc({ name = "Arch", nodes = [], edges = [] } = {}) {
  return { meta: { name, diagramType: "architecture" }, nodes, edges };
}

test("identical documents report no changes", () => {
  const a = doc({ nodes: [{ id: "n1", data: { label: "API", type: "service" }, position: { x: 0, y: 0 } }] });
  const b = doc({ nodes: [{ id: "n1", data: { label: "API", type: "service" }, position: { x: 0, y: 0 } }] });
  const delta = diffDocuments(a, b);
  assert.equal(delta.hasChanges, false);
  assert.match(renderDocDelta(delta), /identical/);
});

test("detects a node added on the cloud side", () => {
  const local = doc({ nodes: [{ id: "n1", data: { label: "API" } }] });
  const cloud = doc({
    nodes: [
      { id: "n1", data: { label: "API" } },
      { id: "n2", data: { label: "DB" } },
    ],
  });
  const delta = diffDocuments(local, cloud);
  assert.equal(delta.hasChanges, true);
  assert.equal(delta.counts.nodesAdded, 1);
  assert.equal(delta.nodes.added[0].id, "n2");
});

test("detects a node only present locally as removed", () => {
  const local = doc({
    nodes: [
      { id: "n1", data: { label: "API" } },
      { id: "gone", data: { label: "Legacy" } },
    ],
  });
  const cloud = doc({ nodes: [{ id: "n1", data: { label: "API" } }] });
  const delta = diffDocuments(local, cloud);
  assert.equal(delta.counts.nodesRemoved, 1);
  assert.equal(delta.nodes.removed[0].id, "gone");
});

test("a pure position move is flagged layout-only, not a structural change", () => {
  const local = doc({ nodes: [{ id: "n1", data: { label: "API" }, position: { x: 0, y: 0 } }] });
  const cloud = doc({ nodes: [{ id: "n1", data: { label: "API" }, position: { x: 120, y: 40 } }] });
  const delta = diffDocuments(local, cloud);
  assert.equal(delta.counts.nodePositionMoves, 1);
  assert.equal(delta.counts.nodesChanged, 0);
  assert.equal(delta.nodes.changed[0].positionOnly, true);
});

test("a label change is a structural change, not layout", () => {
  const local = doc({ nodes: [{ id: "n1", data: { label: "API" }, position: { x: 0, y: 0 } }] });
  const cloud = doc({ nodes: [{ id: "n1", data: { label: "Gateway" }, position: { x: 0, y: 0 } }] });
  const delta = diffDocuments(local, cloud);
  assert.equal(delta.counts.nodesChanged, 1);
  assert.equal(delta.counts.nodePositionMoves, 0);
  assert.ok(delta.nodes.changed[0].fields.includes("label"));
});

test("detects added/removed/relabeled edges", () => {
  const local = doc({
    edges: [
      { id: "e1", source: "a", target: "b", label: "calls" },
      { id: "old", source: "a", target: "c", label: "x" },
    ],
  });
  const cloud = doc({
    edges: [
      { id: "e1", source: "a", target: "b", label: "invokes" },
      { id: "new", source: "b", target: "d", label: "y" },
    ],
  });
  const delta = diffDocuments(local, cloud);
  assert.equal(delta.counts.edgesAdded, 1);
  assert.equal(delta.counts.edgesRemoved, 1);
  assert.equal(delta.counts.edgesChanged, 1);
});

test("detects a diagram title change", () => {
  const delta = diffDocuments(doc({ name: "Old" }), doc({ name: "New" }));
  assert.equal(delta.hasChanges, true);
  assert.deepEqual(delta.name, { local: "Old", cloud: "New" });
});
