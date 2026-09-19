import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { buildDocument } from "../lib/build.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = resolve(HERE, "..", "examples");

test("by default a diagram gets a scene story AND animates (engine-derived motion)", () => {
  const result = buildDocument({
    name: "X",
    diagramType: "architecture",
    nodes: [
      { id: "a", label: "Browser", type: "arch-frontend" },
      { id: "b", label: "API", type: "arch-backend" },
      { id: "c", label: "DB", type: "infra-postgresql" },
    ],
    edges: [
      { source: "a", target: "b", label: "HTTPS" },
      { source: "b", target: "c", label: "SQL" },
    ],
    beats: [
      { title: "Browser calls API", nodeIds: ["a", "b"] },
      { title: "API reads DB", nodeIds: ["c"] },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.motion, "animated");
  // The walkthrough is present…
  assert.equal(result.document.motion.story.scenes[0].steps.length, 2);
  // …and the engine derived motion for the elements the beats touch.
  const animated = [...result.document.nodes, ...result.document.edges].filter((e) => e.data?.preset);
  assert.ok(animated.length > 0, "expected engine-derived motion by default");
});

test("every edge on every diagram type animates and loops by default", () => {
  // Types the engine/WebMCP would leave static (flowchart control-flow, ER
  // structural) must still animate under the skill's policy.
  const cases = [
    {
      diagramType: "flowchart",
      nodes: [
        { id: "s", label: "Start", type: "terminator" },
        { id: "p", label: "Process", type: "process" },
      ],
      edges: [{ source: "s", target: "p", label: "begin" }],
    },
    {
      diagramType: "entity-relationship",
      nodes: [
        { id: "c", label: "Customer", type: "er-entity" },
        { id: "o", label: "Order", type: "er-entity" },
      ],
      edges: [{ source: "c", target: "o", label: "places" }],
    },
    {
      diagramType: "architecture",
      nodes: [
        { id: "a", label: "Web", type: "arch-frontend" },
        { id: "b", label: "API", type: "arch-backend" },
      ],
      edges: [{ source: "a", target: "b", label: "HTTPS" }],
    },
  ];
  for (const spec of cases) {
    const result = buildDocument(spec);
    assert.equal(result.ok, true, spec.diagramType);
    assert.equal(result.motion, "animated", spec.diagramType);
    for (const e of result.document.edges) {
      assert.ok(e.data.preset, `${spec.diagramType}: every edge has a preset`);
      assert.equal(e.data.motionLoop, true, `${spec.diagramType}: edge loops continuously`);
    }
  }
});

test("sequence edges get the Sequence Flow preset by default", () => {
  const result = buildDocument({
    diagramType: "sequence",
    nodes: [
      { id: "u", label: "User", type: "sequence-actor" },
      { id: "a", label: "API", type: "sequence-participant" },
    ],
    edges: [{ source: "u", target: "a", label: "POST", type: "sequence-message" }],
  });
  assert.equal(result.document.edges[0].data.preset, "Sequence Flow");
  assert.equal(result.document.edges[0].data.motionLoop, true);
});

test("author-set edge motion is respected under the animate-by-default policy", () => {
  const result = buildDocument({
    diagramType: "architecture",
    nodes: [
      { id: "a", label: "Web", type: "arch-frontend" },
      { id: "b", label: "API", type: "arch-backend" },
      { id: "c", label: "DB", type: "infra-postgresql" },
    ],
    edges: [
      { source: "a", target: "b", label: "HTTPS", motion: { preset: "Pulse", loop: false } },
      { source: "b", target: "c", label: "SQL" },
    ],
  });
  const ab = result.document.edges.find((e) => e.source === "a");
  const bc = result.document.edges.find((e) => e.source === "b");
  // Explicit preset + explicit loop:false are both preserved.
  assert.equal(ab.data.preset, "Pulse");
  assert.equal(ab.data.motionLoop, false);
  // The plain edge gets the looping default.
  assert.equal(bc.data.preset, "Data Flow");
  assert.equal(bc.data.motionLoop, true);
});

test("--static strips the default edge motion", () => {
  const spec = {
    name: "X",
    diagramType: "architecture",
    nodes: [
      { id: "a", label: "A", type: "arch-frontend" },
      { id: "b", label: "B", type: "arch-backend" },
    ],
    edges: [{ source: "a", target: "b", label: "x" }],
    beats: [{ title: "flow", nodeIds: ["a", "b"] }],
  };
  const still = buildDocument(spec, { static: true });
  assert.equal(still.motion, "static");
  assert.equal(still.document.motion.story.scenes[0].steps.length, 1);
  const animated = [...still.document.nodes, ...still.document.edges].filter((e) => e.data?.preset);
  assert.equal(animated.length, 0);
});

test("legacy { animate: false } still yields a static build", () => {
  const result = buildDocument(
    {
      diagramType: "architecture",
      nodes: [
        { id: "a", label: "A", type: "arch-frontend" },
        { id: "b", label: "B", type: "arch-backend" },
      ],
      edges: [{ source: "a", target: "b", label: "x" }],
      beats: [{ title: "flow", nodeIds: ["a", "b"] }],
    },
    { animate: false },
  );
  assert.equal(result.motion, "static");
});

test("author-set motion survives a --static build; engine-derived motion is stripped", () => {
  const result = buildDocument(
    {
      name: "X",
      diagramType: "architecture",
      nodes: [
        { id: "a", label: "API", type: "arch-backend", motion: { preset: "Pulse Node" } },
        { id: "b", label: "DB", type: "infra-postgresql" },
      ],
      edges: [{ source: "a", target: "b", label: "SQL" }],
      beats: [{ title: "read", nodeIds: ["a", "b"] }],
    },
    { static: true },
  );
  const withMotion = [...result.document.nodes, ...result.document.edges]
    .filter((e) => e.data?.preset)
    .map((e) => e.data.preset);
  // The author's explicit Pulse Node is kept; the derived edge Data Flow is gone.
  assert.deepEqual(withMotion, ["Pulse Node"]);
});

test('beats can target an edge by "source>target" and get one message per step', () => {
  const result = buildDocument({
    name: "Order sequence",
    diagramType: "sequence",
    nodes: [
      { id: "user", label: "User", type: "sequence-actor" },
      { id: "client", label: "Client", type: "sequence-participant" },
      { id: "api", label: "API", type: "sequence-participant" },
    ],
    edges: [
      { source: "user", target: "client", label: "Click checkout", type: "sequence-message" },
      { source: "client", target: "api", label: "POST /checkout", type: "sequence-message" },
    ],
    beats: [
      { title: "User clicks checkout", edgeIds: ["user>client"] },
      { title: "Client posts to the API", edgeIds: ["client>api"] },
    ],
  });
  assert.equal(result.ok, true);
  const steps = result.document.motion.story.scenes[0].steps;
  // Each step targets exactly ONE edge — not the participant nodes, which would
  // fire several messages at once.
  assert.equal(steps.length, 2);
  assert.equal(steps[0].targets.length, 1);
  assert.equal(steps[0].targets[0].targetKind, "edge");
  assert.equal(steps[1].targets.length, 1);
  assert.notEqual(steps[0].targets[0].targetId, steps[1].targets[0].targetId);
});

test('"source>target#N" selects the Nth message between the same pair', () => {
  const result = buildDocument({
    name: "Repeat",
    diagramType: "sequence",
    nodes: [
      { id: "a", label: "A", type: "sequence-participant" },
      { id: "b", label: "B", type: "sequence-participant" },
    ],
    edges: [
      { source: "a", target: "b", label: "first", type: "sequence-message" },
      { source: "a", target: "b", label: "second", type: "sequence-message" },
    ],
    beats: [
      { title: "first call", edgeIds: ["a>b#1"] },
      { title: "second call", edgeIds: ["a>b#2"] },
    ],
  });
  assert.equal(result.ok, true);
  const steps = result.document.motion.story.scenes[0].steps;
  assert.equal(steps.length, 2);
  assert.notEqual(steps[0].targets[0].targetId, steps[1].targets[0].targetId);
});

test("node and edge motion presets compile onto the document", () => {
  const result = buildDocument({
    diagramType: "architecture",
    nodes: [
      { id: "api", label: "API", type: "arch-backend", motion: { preset: "Pulse Node" } },
      { id: "db", label: "Postgres", type: "infra-postgresql" },
    ],
    edges: [
      {
        source: "api",
        target: "db",
        label: "SQL",
        motion: { preset: "Data Flow", loop: false, speed: 1.5 },
      },
    ],
  });
  assert.equal(result.ok, true);
  const api = result.document.nodes.find((n) => n.id === "api");
  assert.equal(api.data.preset, "Pulse Node");
  const edge = result.document.edges[0];
  assert.equal(edge.data.preset, "Data Flow");
  assert.equal(edge.data.motionLoop, false);
  assert.equal(edge.data.motionSpeed, 1.5);
});

test("beats compile into a scene story with generated ids and targets", () => {
  const result = buildDocument({
    diagramType: "architecture",
    nodes: [
      { id: "a", label: "A", type: "arch-backend" },
      { id: "b", label: "B", type: "infra-postgresql" },
    ],
    edges: [{ source: "a", target: "b", label: "SQL" }],
    beats: [
      { title: "First", nodeIds: ["a"], kind: "request" },
      { title: "Then", nodeIds: ["b"], kind: "data-flow" },
    ],
  });
  assert.equal(result.ok, true);
  const scenes = result.document.motion?.story?.scenes;
  assert.ok(Array.isArray(scenes) && scenes.length >= 1, "expected a compiled scene");
  const steps = scenes[0].steps;
  assert.equal(steps.length, 2);
  assert.ok(steps[0].id, "steps get generated ids");
  assert.equal(steps[0].targets[0].targetId, "a");
});

test("an explicit story with ids is accepted", () => {
  const result = buildDocument({
    diagramType: "sequence",
    nodes: [
      { id: "u", label: "User", type: "sequence-participant" },
      { id: "s", label: "Server", type: "sequence-participant" },
    ],
    edges: [{ source: "u", target: "s", label: "req", type: "sequence-message" }],
    story: {
      scenes: [
        {
          id: "sc1",
          title: "Call",
          steps: [
            {
              id: "st1",
              title: "User calls",
              targets: [{ targetId: "u", targetKind: "node" }],
              durationMs: 900,
            },
          ],
        },
      ],
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.document.motion.story.scenes[0].id, "sc1");
  assert.equal(result.document.motion.story.scenes[0].steps[0].durationMs, 900);
});

test("an invalid motion preset fails the build with a structured issue", () => {
  const result = buildDocument({
    diagramType: "architecture",
    nodes: [{ id: "a", label: "A", type: "arch-backend", motion: { preset: "Wobble" } }],
    edges: [],
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.length >= 1);
});

test("a story/beat target that is not in the diagram surfaces a warning (was silently dropped)", () => {
  const result = buildDocument({
    diagramType: "architecture",
    nodes: [{ id: "a", label: "Service", type: "arch-backend" }],
    edges: [],
    beats: [{ title: "Ghost", nodeIds: ["nope"] }],
  });
  // The document is structurally valid, so the build itself succeeds…
  assert.equal(result.ok, true);
  // …but the dangling target is now visible instead of vanishing.
  assert.equal(result.validation.ok, false);
  assert.ok(
    result.validation.issues.some((i) => i.code === "STORY_TARGET_NOT_FOUND" && i.elementId === "nope"),
    "expected a STORY_TARGET_NOT_FOUND warning for the unknown target",
  );
});

test("a real story with valid targets produces no dropped-target warning", () => {
  const result = buildDocument({
    diagramType: "architecture",
    nodes: [
      { id: "a", label: "Service", type: "arch-backend" },
      { id: "b", label: "Postgres", type: "infra-postgresql" },
    ],
    edges: [{ source: "a", target: "b", label: "SQL" }],
    beats: [{ title: "Query", nodeIds: ["a", "b"] }],
  });
  assert.equal(result.ok, true);
  assert.ok(!result.validation.issues.some((i) => i.code === "STORY_TARGET_NOT_FOUND"));
});

test("the animated example builds cleanly with a compiled story", () => {
  const spec = JSON.parse(readFileSync(join(EXAMPLES, "architecture-animated.json"), "utf8"));
  const result = buildDocument(spec);
  assert.equal(result.ok, true);
  assert.ok(result.document.motion?.story?.scenes?.length >= 1);
});
