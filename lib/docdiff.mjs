// Node/edge-level delta between two DrawCMS documents. Used by
// `drawcms diff --against-cloud` so an agent (or human) can see exactly how the
// local working copy and the current cloud document diverged before deciding
// how to resolve a conflict — instead of the coarse "they differ" signal the
// hash comparison gives.
//
// This is a structural diff, not a merge: it reports added / removed / changed
// nodes and edges (keyed by id), plus whether node positions moved. It never
// mutates either document. Position-only changes are called out separately
// because they are the common "a human dragged nodes in the editor" case — the
// exact thing `drawcms edit` is designed to preserve.

/** Pull the comparable fields off a node, tolerating both authored-spec and
 * rendered-document shapes (label/type live under `data` in a rendered doc, but
 * at the top level in an authored spec). */
function nodeShape(node) {
  const data = node.data ?? {};
  return {
    id: node.id,
    label: node.label ?? data.label ?? null,
    type: node.type === "customShape" ? (data.type ?? null) : (node.type ?? data.type ?? null),
    position: node.position ? { x: node.position.x ?? null, y: node.position.y ?? null } : null,
  };
}

function edgeShape(edge) {
  const data = edge.data ?? {};
  return {
    id: edge.id,
    source: edge.source ?? null,
    target: edge.target ?? null,
    label: edge.label ?? data.label ?? null,
  };
}

function byId(items, shape) {
  const map = new Map();
  for (const item of items ?? []) {
    if (item && item.id != null) map.set(item.id, shape(item));
  }
  return map;
}

function samePosition(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y;
}

/** Diff a collection keyed by id. Returns { added, removed, changed } where
 * `changed` records which comparable fields differ. For nodes, a change that is
 * *only* a position move is flagged `positionOnly` so callers can treat manual
 * layout separately from structural edits. */
function diffCollection(localMap, cloudMap, { trackPosition = false } = {}) {
  const added = []; // present on cloud, absent locally
  const removed = []; // present locally, absent on cloud
  const changed = [];

  for (const [id, cloud] of cloudMap) {
    if (!localMap.has(id)) added.push({ id, ...cloud });
  }
  for (const [id, local] of localMap) {
    const cloud = cloudMap.get(id);
    if (!cloud) {
      removed.push({ id, ...local });
      continue;
    }
    const fields = [];
    for (const key of Object.keys(local)) {
      if (key === "id") continue;
      if (key === "position") {
        if (trackPosition && !samePosition(local.position, cloud.position)) fields.push("position");
        continue;
      }
      if (local[key] !== cloud[key]) fields.push(key);
    }
    if (fields.length) {
      const positionOnly = fields.length === 1 && fields[0] === "position";
      changed.push({ id, fields, positionOnly, local, cloud });
    }
  }
  return { added, removed, changed };
}

/**
 * Compare a local document against the cloud document.
 * `local` and `cloud` are the parsed document objects ({ nodes, edges, ... }).
 * Returns a stable, JSON-serializable delta plus a `hasChanges` flag and small
 * counts for a one-line human summary.
 */
export function diffDocuments(local, cloud) {
  const nodes = diffCollection(byId(local?.nodes, nodeShape), byId(cloud?.nodes, nodeShape), {
    trackPosition: true,
  });
  const edges = diffCollection(byId(local?.edges, edgeShape), byId(cloud?.edges, edgeShape));

  const nameLocal = local?.meta?.name ?? null;
  const nameCloud = cloud?.meta?.name ?? null;
  const nameChanged = nameLocal !== nameCloud;

  const positionMoves = nodes.changed.filter((c) => c.positionOnly).length;
  const structuralNodeChanges = nodes.changed.length - positionMoves;

  const counts = {
    nodesAdded: nodes.added.length,
    nodesRemoved: nodes.removed.length,
    nodesChanged: structuralNodeChanges,
    nodePositionMoves: positionMoves,
    edgesAdded: edges.added.length,
    edgesRemoved: edges.removed.length,
    edgesChanged: edges.changed.length,
  };
  const hasChanges =
    nameChanged || Object.values(counts).some((n) => n > 0);

  return {
    hasChanges,
    name: nameChanged ? { local: nameLocal, cloud: nameCloud } : null,
    nodes,
    edges,
    counts,
  };
}

/** A compact multi-line human summary of a delta from diffDocuments(). */
export function renderDocDelta(delta) {
  if (!delta.hasChanges) return "  local and cloud documents are identical.\n";
  const lines = [];
  if (delta.name) {
    lines.push(`  title: local "${delta.name.local ?? ""}" ≠ cloud "${delta.name.cloud ?? ""}"`);
  }
  const c = delta.counts;
  const seg = [];
  if (c.nodesAdded) seg.push(`+${c.nodesAdded} node(s) on cloud`);
  if (c.nodesRemoved) seg.push(`-${c.nodesRemoved} node(s) (only local)`);
  if (c.nodesChanged) seg.push(`~${c.nodesChanged} node(s) changed`);
  if (c.nodePositionMoves) seg.push(`${c.nodePositionMoves} node(s) moved (layout only)`);
  if (c.edgesAdded) seg.push(`+${c.edgesAdded} edge(s) on cloud`);
  if (c.edgesRemoved) seg.push(`-${c.edgesRemoved} edge(s) (only local)`);
  if (c.edgesChanged) seg.push(`~${c.edgesChanged} edge(s) changed`);
  if (seg.length) lines.push("  " + seg.join(", "));

  for (const n of delta.nodes.added) lines.push(`    + node ${n.id} "${n.label ?? ""}"`);
  for (const n of delta.nodes.removed) lines.push(`    - node ${n.id} "${n.label ?? ""}"`);
  for (const n of delta.nodes.changed) {
    lines.push(`    ~ node ${n.id}: ${n.fields.join(", ")}${n.positionOnly ? " (layout only)" : ""}`);
  }
  for (const e of delta.edges.added) lines.push(`    + edge ${e.id} (${e.source}→${e.target})`);
  for (const e of delta.edges.removed) lines.push(`    - edge ${e.id} (${e.source}→${e.target})`);
  for (const e of delta.edges.changed) lines.push(`    ~ edge ${e.id}: ${e.fields.join(", ")}`);

  return lines.join("\n") + "\n";
}
