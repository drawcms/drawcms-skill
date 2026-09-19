// `drawcms doctor` — verifies the environment can build diagrams: Node version,
// the bundled engine loads, and the vocabulary is reachable. Read-only.

import { emit } from "../output.mjs";

export async function run({ flags }) {
  const checks = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "node",
    ok: nodeMajor >= 18,
    detail: `node ${process.versions.node} (need >=18)`,
  });

  let engineOk = false;
  let editorVersion = null;
  let diagramTypes = [];
  try {
    const engine = await import("../engine.mjs");
    editorVersion = engine.ENGINE_EDITOR_VERSION ?? null;
    diagramTypes = engine.VISUAL_DIAGRAM_TYPES ?? [];
    // Smoke-build a trivial document to prove the engine actually runs.
    const doc = engine.createDocumentFromWebMCP({
      diagramType: "architecture",
      nodes: [
        { id: "a", label: "Client", type: "arch-frontend" },
        { id: "b", label: "Server", type: "arch-backend" },
      ],
      edges: [{ source: "a", target: "b", label: "request" }],
    });
    engineOk = Array.isArray(doc.nodes) && doc.nodes.length === 2;
  } catch (error) {
    // The bundle is a fetched release asset (gitignored), so "not fetched yet"
    // is the most likely cause on a fresh checkout — say what to do about it.
    const missing = /Cannot find module/.test(error.message ?? "");
    checks.push({
      name: "engine",
      ok: false,
      detail: missing
        ? "diagram engine bundle missing — run `npm run fetch-engine` in the skill folder"
        : error.message,
    });
  }
  if (editorVersion !== null || engineOk) {
    checks.push({
      name: "engine",
      ok: engineOk,
      detail: engineOk
        ? `diagram engine loads (editor ${editorVersion}, ${diagramTypes.length} diagram types)`
        : "engine present but smoke build failed",
    });
  }

  const ok = checks.every((c) => c.ok);
  emit(
    {
      ok,
      command: "doctor",
      editorVersion,
      checks,
      render() {
        for (const c of checks) {
          process.stdout.write(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}\n`);
        }
        process.stdout.write(ok ? "\ndoctor: all checks passed\n" : "\ndoctor: problems found\n");
      },
    },
    { json: flags.json },
  );
  process.exit(ok ? 0 : 1);
}
