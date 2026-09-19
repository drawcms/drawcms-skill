// Deterministic build + validate step. This is the archify-style engine half of
// the skill: it takes agent-authored typed JSON and either returns a validated
// DrawCMS document with a machine-readable receipt, or a structured failure the
// agent can repair. No LLM, no network, no browser.

import { readFile } from "node:fs/promises";
import {
  createDocumentFromWebMCP,
  validateDiagramVisualGrammar,
  VISUAL_DIAGRAM_TYPES,
  ENGINE_EDITOR_VERSION,
} from "./engine.mjs";

export { VISUAL_DIAGRAM_TYPES, ENGINE_EDITOR_VERSION };

/** Diagram types the skill exposes as top-level `<type>` CLI arguments. The
 * engine understands more (uml, bpmn, er, …); those remain reachable by setting
 * `diagramType` in the JSON, but the five below are the routed primary set. */
export const PRIMARY_DIAGRAM_TYPES = [
  "architecture",
  "flowchart",
  "sequence",
  "data-flow",
  "lifecycle",
];

/**
 * Normalize a thrown value (usually a ZodError) into a stable array of issue
 * objects: { code, path, message, received? }. Anything unrecognized becomes a
 * single ENGINE_ERROR issue so the caller never has to introspect a raw throw.
 */
export function normalizeIssues(error) {
  if (error && Array.isArray(error.issues)) {
    return error.issues.map((issue) => ({
      code: issue.code ?? "invalid",
      path: Array.isArray(issue.path) ? issue.path.join(".") : String(issue.path ?? ""),
      message: issue.message ?? "Invalid value.",
      ...(issue.received !== undefined ? { received: issue.received } : {}),
      ...(Array.isArray(issue.options) ? { allowed: issue.options } : {}),
    }));
  }
  return [
    {
      code: "ENGINE_ERROR",
      path: "",
      message: error instanceof Error ? error.message : String(error),
    },
  ];
}

/**
 * Build a document from an already-parsed spec object.
 *
 * @param {object} spec  the authoring spec ({ diagramType, nodes, edges, beats?, story?, ... })
 * @param {object} [options]
 * @param {boolean} [options.animate=false]  keep engine-derived motion presets.
 *   By default the skill produces a STATIC guided walkthrough: any scene story
 *   (from beats or an explicit story) is preserved, but the motion presets the
 *   engine attaches to the elements a beat touches are stripped — unless the
 *   author set `motion` on that element explicitly, or `animate` is true. This
 *   keeps "story by default, motion opt-in": every diagram gets clickable steps
 *   without gratuitous animation.
 *
 * Returns a discriminated result:
 *   { ok: true, document, validation, motion: "static"|"animated" }
 *   { ok: false, stage: "build", issues }
 */
export function buildDocument(spec, options = {}) {
  const animate = options.animate === true;
  // Let beats/story reference messages by "source>target" (or
  // "source>target#N" for the Nth message between that pair) — the
  // author-friendly form — instead of the engine's generated edge ids, which
  // are not knowable at authoring time. This is what makes a per-message
  // sequence walkthrough authorable (one edge per step) instead of forcing the
  // agent to target participant nodes, which lights up every message between
  // them at once. Rewrites the spec in place with stable explicit edge ids.
  const resolvedSpec = resolveEdgeReferences(spec);

  let document;
  try {
    document = createDocumentFromWebMCP(resolvedSpec);
  } catch (error) {
    return { ok: false, stage: "build", issues: normalizeIssues(error) };
  }

  let motion = "static";
  if (animate) {
    // Whatever the engine derived (or the author set) stands.
    motion = hasAnyMotion(document) ? "animated" : "static";
  } else {
    // Static default: drop engine-derived element motion, but never touch
    // motion the author asked for explicitly in the spec.
    stripDerivedMotion(document, elementsWithAuthoredMotion(resolvedSpec));
    motion = hasAnyMotion(document) ? "animated" : "static";
  }

  const validation = runGrammarValidation(document, document.meta?.diagramType);
  // The engine silently drops beat/story targets that name an id not in the
  // diagram (they compile to empty targets rather than erroring). Surface those
  // as warnings so a typo'd target id is visible instead of producing a step
  // that highlights nothing.
  const dropped = detectDroppedStoryTargets(resolvedSpec, document);
  if (dropped.length) {
    validation.issues = [...(validation.issues ?? []), ...dropped];
    validation.ok = false;
  }
  return { ok: true, document, validation, motion };
}

const EDGE_REF = /^(.+?)>(.+?)(?:#(\d+))?$/;

/**
 * Rewrite author-friendly edge references ("source>target" or
 * "source>target#N") in beats/story into stable explicit edge ids, assigning
 * those ids to the matching edges in the spec so the built document carries
 * them. Refs that already look like a real edge id (no ">") or do not match any
 * edge are left untouched (detectDroppedStoryTargets will warn on the latter).
 * Returns a shallow-cloned spec; the input is not mutated.
 */
export function resolveEdgeReferences(spec) {
  if (!spec || typeof spec !== "object" || !Array.isArray(spec.edges)) return spec;
  const hasBeatRefs = Array.isArray(spec.beats) && spec.beats.some((b) => (b?.edgeIds ?? []).some((r) => typeof r === "string" && r.includes(">")));
  const hasStoryRefs =
    spec.story?.scenes?.some((sc) => sc?.steps?.some((st) => (st?.targets ?? []).some((t) => t?.targetKind === "edge" && typeof t.targetId === "string" && t.targetId.includes(">")))) ?? false;
  if (!hasBeatRefs && !hasStoryRefs) return spec;

  const edges = spec.edges.map((e) => ({ ...e }));
  // Resolve one "src>tgt#n" ref to an edge, assigning it a stable id if needed.
  const idFor = (ref) => {
    const m = EDGE_REF.exec(ref);
    if (!m) return null;
    const [, src, tgt, nth] = m;
    const want = nth ? Number(nth) : 1;
    let seen = 0;
    for (const e of edges) {
      if (e.source === src && e.target === tgt) {
        seen += 1;
        if (seen === want) {
          if (!e.id) e.id = `edge-${src}-${tgt}-${want}`;
          return e.id;
        }
      }
    }
    return null; // no match — leave the ref as-is; it will surface as a warning
  };

  const clone = { ...spec, edges };
  if (Array.isArray(spec.beats)) {
    clone.beats = spec.beats.map((b) => {
      if (!Array.isArray(b?.edgeIds)) return b;
      return { ...b, edgeIds: b.edgeIds.map((r) => (typeof r === "string" && r.includes(">") ? (idFor(r) ?? r) : r)) };
    });
  }
  if (spec.story?.scenes) {
    clone.story = {
      ...spec.story,
      scenes: spec.story.scenes.map((sc) => ({
        ...sc,
        steps: (sc.steps ?? []).map((st) => ({
          ...st,
          targets: (st.targets ?? []).map((t) =>
            t?.targetKind === "edge" && typeof t.targetId === "string" && t.targetId.includes(">")
              ? { ...t, targetId: idFor(t.targetId) ?? t.targetId }
              : t,
          ),
        })),
      })),
    };
  }
  return clone;
}

const MOTION_FIELDS = ["preset", "motionSpeed", "motionLoop"];

/** Ids of nodes/edges the author explicitly gave a `motion` in the input spec —
 * their presets are intentional and must survive a static build. Edges are keyed
 * by source>target because the author does not know the engine-generated edge id. */
function elementsWithAuthoredMotion(spec) {
  const nodes = new Set();
  const edges = new Set();
  if (!spec || typeof spec !== "object") return { nodes, edges };
  for (const n of Array.isArray(spec.nodes) ? spec.nodes : []) {
    if (n?.motion?.preset && n.id) nodes.add(n.id);
  }
  for (const e of Array.isArray(spec.edges) ? spec.edges : []) {
    if (e?.motion?.preset && e.source && e.target) edges.add(`${e.source}>${e.target}`);
  }
  return { nodes, edges };
}

/** Remove engine-derived motion presets, preserving author-specified ones. */
function stripDerivedMotion(document, authored) {
  for (const node of document.nodes ?? []) {
    if (authored.nodes.has(node.id)) continue;
    for (const f of MOTION_FIELDS) delete node.data?.[f];
  }
  for (const edge of document.edges ?? []) {
    if (authored.edges.has(`${edge.source}>${edge.target}`)) continue;
    for (const f of MOTION_FIELDS) delete edge.data?.[f];
  }
}

function hasAnyMotion(document) {
  return [...(document.nodes ?? []), ...(document.edges ?? [])].some((el) => el.data?.preset);
}

/**
 * Compare the target ids the author referenced in `beats` / `story` against the
 * ids that actually exist in the built document, and report any that are not
 * present. These would otherwise vanish without a trace.
 */
export function detectDroppedStoryTargets(spec, document) {
  if (!spec || typeof spec !== "object") return [];
  const known = new Set([
    ...(document.nodes ?? []).map((n) => n.id),
    ...(document.edges ?? []).map((e) => e.id),
    // Edges are often referenced by endpoint pair in authoring; also accept the
    // source/target node ids so a beat naming a node an edge touches is fine.
  ]);
  const referenced = new Set();
  for (const beat of Array.isArray(spec.beats) ? spec.beats : []) {
    for (const id of beat?.nodeIds ?? []) referenced.add(id);
    for (const id of beat?.edgeIds ?? []) referenced.add(id);
  }
  for (const scene of spec.story?.scenes ?? []) {
    for (const step of scene?.steps ?? []) {
      for (const t of step?.targets ?? []) if (t?.targetId) referenced.add(t.targetId);
    }
  }
  const missing = [...referenced].filter((id) => !known.has(id));
  return missing.map((id) => ({
    severity: "warning",
    code: "STORY_TARGET_NOT_FOUND",
    elementId: id,
    message: `Story/beat references "${id}", which is not a node or edge in the diagram — that step will highlight nothing. Fix the id or remove the reference.`,
  }));
}

/**
 * Normalize the editor's grammar validator into a stable { ok, issues[] } shape.
 * The validator returns a report object ({ ok, diagramType, issueCount, issues })
 * rather than a bare array, and could in principle throw; both are handled so
 * the caller always gets the same structure.
 */
export function runGrammarValidation(document, diagramType) {
  try {
    const report =
      diagramType !== undefined
        ? validateDiagramVisualGrammar(document, diagramType)
        : validateDiagramVisualGrammar(document);
    if (report && Array.isArray(report.issues)) {
      return { ok: report.ok !== false && report.issues.length === 0, issues: report.issues };
    }
    if (Array.isArray(report)) {
      return { ok: report.length === 0, issues: report };
    }
    return { ok: true, issues: [] };
  } catch (error) {
    return {
      ok: false,
      issues: [{ code: "VALIDATOR_ERROR", message: normalizeIssues(error)[0]?.message ?? "validator threw" }],
    };
  }
}

/** Read + JSON.parse a spec file, returning a structured failure on bad JSON
 * rather than throwing, so the CLI emits a machine receipt for every path. */
export async function readSpecFile(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    return {
      ok: false,
      stage: "read",
      issues: [{ code: "FILE_NOT_READABLE", path, message: error.message }],
    };
  }
  try {
    return { ok: true, spec: JSON.parse(raw) };
  } catch (error) {
    return {
      ok: false,
      stage: "parse",
      issues: [{ code: "INVALID_JSON", path, message: error.message }],
    };
  }
}

/**
 * Reconcile the CLI `<type>` argument with the spec's own `diagramType`.
 * The CLI arg is authoritative for routing but must not silently override an
 * explicit conflicting diagramType — that usually signals an authoring mistake.
 */
export function resolveDiagramType(cliType, spec) {
  const specType = spec && typeof spec === "object" ? spec.diagramType : undefined;
  if (cliType && specType && cliType !== specType) {
    return {
      ok: false,
      issues: [
        {
          code: "DIAGRAM_TYPE_CONFLICT",
          path: "diagramType",
          message: `CLI type "${cliType}" conflicts with spec diagramType "${specType}". Remove one.`,
        },
      ],
    };
  }
  return { ok: true, diagramType: cliType ?? specType };
}

/**
 * Coerce a local diagram file into the input-spec shape createDocumentFromWebMCP
 * accepts. A tracked file may be either an agent-authored spec
 * ({ diagramType, nodes, edges, motion? }) or a full built/pulled document
 * ({ meta: { name, diagramType }, nodes, edges, motion }). The builder rejects
 * the extra `meta` key, so lift what it needs (diagramType, name) and drop the
 * rest. Authoring specs pass through unchanged.
 */
export function toBuildSpec(doc) {
  if (!doc || typeof doc !== "object") return doc;
  if (!("meta" in doc)) return doc;
  const { meta, ...rest } = doc;
  const spec = { ...rest };
  delete spec.meta;
  if (spec.diagramType === undefined && meta && typeof meta === "object" && meta.diagramType) {
    spec.diagramType = meta.diagramType;
  }
  if (spec.name === undefined && meta && typeof meta === "object" && meta.name) {
    spec.name = meta.name;
  }
  return spec;
}
