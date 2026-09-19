// `drawcms push` — validate each tracked diagram's local document and persist
// it to the cloud, git-style. It fails closed (an invalid document is never
// pushed) and refuses on a version conflict rather than merging: the diagram is
// a derived artifact, so the safe resolution is `drawcms pull` then re-generate.
//
// On success it records the new server version, re-hashes the built document as
// the working baseline, and stamps the repo's lastSyncedCommit so `status` can
// tell whether the diagram reflects the latest code.

import { emit } from "../output.mjs";
import { createApi } from "../api.mjs";
import { readConfig, resolveAuthenticatedOrigin, diagramUrl } from "../config.mjs";
import { readProjectConfig, writeProjectConfig, ensureProjectGitignore } from "../project.mjs";
import { readDocument, writeDocument, writeStash } from "../docfile.mjs";
import { buildDocument, toBuildSpec } from "../build.mjs";
import { headCommit } from "../git.mjs";

const HELP = `drawcms push [name] [--force] [--static] [--json]

Validates the local diagram document(s) and saves them to DrawCMS. With no name,
pushes every tracked diagram.

  [name]     Push only this logical diagram (default: all tracked).
  --force    Overwrite even if the server version moved (skips conflict check).
             Before overwriting, the current cloud document is saved to
             .drawcms/<name>.stash.json so the clobbered revision is recoverable.

An invalid document is never pushed. A version conflict is refused — run
\`drawcms pull\` first, then re-generate.`;

/** Map a built/stored document ({meta,nodes,edges,motion}) to the save payload. */
function toSavePayload(document, baseVersion, force) {
  return {
    nodes: document.nodes ?? [],
    edges: document.edges ?? [],
    ...(document.motion !== undefined ? { motion: document.motion } : {}),
    ...(document.meta?.name ? { name: document.meta.name } : {}),
    ...(baseVersion != null ? { baseVersion } : {}),
    ...(force ? { force: true } : {}),
  };
}

export async function run({ flags, positional }) {
  if (flags.help) {
    process.stdout.write(HELP + "\n");
    process.exit(0);
  }

  const link = await readProjectConfig();
  if (!link) return fail(flags.json, "NOT_INITIALIZED", "Run `drawcms init` in this repo first.");

  const config = await readConfig();
  if (!config.token) return fail(flags.json, "NOT_LOGGED_IN", "Run `drawcms login` first.");
  const resolved = resolveAuthenticatedOrigin(flags, config, link.origin);
  if (!resolved.ok) return fail(flags.json, resolved.code, resolved.message);
  const { origin, crossOrigin, loginOrigin } = resolved;
  if (crossOrigin && !flags.origin && !process.env.DRAWCMS_ALLOW_CROSS_ORIGIN) {
    return fail(
      flags.json,
      "CROSS_ORIGIN_TOKEN",
      `This repo is bound to ${origin}, but you logged in at ${loginOrigin}. ` +
        `Pushing would send that session token to a different server. If that is intended, ` +
        `re-run with --origin ${origin} or set DRAWCMS_ALLOW_CROSS_ORIGIN=1.`,
    );
  }
  const api = createApi({ origin, token: config.token });

  const names = positional.length ? positional : Object.keys(link.diagrams ?? {});
  if (names.length === 0) {
    return fail(flags.json, "NO_DIAGRAMS", "No diagrams are tracked in .drawcms/config.json.");
  }

  const results = [];
  let changed = false;
  for (const name of names) {
    const entry = link.diagrams?.[name];
    if (!entry) {
      results.push({ name, status: "unknown", message: "not tracked in .drawcms/config.json" });
      continue;
    }

    const local = await readDocument(name);
    if (!local) {
      results.push({ name, status: "missing", message: `no local .drawcms/${name}.json (pull or author it first)` });
      continue;
    }

    // Fail closed: validate/build before any network write. The local file may
    // be the agent-authored typed spec or a previously built/pulled document;
    // toBuildSpec normalizes both into the builder's input shape, then
    // createDocumentFromWebMCP normalizes layout and rejects anything invalid.
    const built = buildDocument(toBuildSpec(local.document), { static: flags.static === true });
    if (!built.ok) {
      results.push({ name, status: "invalid", issues: built.issues });
      continue;
    }

    // Enforce a meaningful diagram name. The engine stamps "AI-generated
    // diagram" when the spec omits `name`; pushing that would leave a generic
    // title in the user's workspace. Fail closed and tell the agent to set a
    // real name derived from the repo and the user's request.
    const builtName = built.document.meta?.name;
    if (!builtName || builtName === "AI-generated diagram" || builtName === "Untitled Diagram") {
      results.push({
        name,
        status: "unnamed",
        message:
          'Set a descriptive "name" in the spec (e.g. "Shopfront runtime architecture") before pushing — it becomes the diagram title in DrawCMS. The generic default is not accepted.',
      });
      continue;
    }

    // Before a forced overwrite, snapshot the current cloud document locally so
    // the revision we are about to clobber is recoverable without a round trip.
    // Best-effort: a fetch failure here must not block the push the user asked
    // for, so we record the outcome and continue.
    let stashedTo = null;
    if (flags.force) {
      const cur = await api.get(`/api/diagrams/${encodeURIComponent(entry.id)}/document`);
      if (cur.ok && cur.data?.document) {
        stashedTo = await writeStash(name, { document: cur.data.document, version: cur.data.version });
        // Make sure the stash is git-ignored even in a repo linked before this
        // behavior existed (no-op when the .gitignore already has the rule).
        await ensureProjectGitignore();
      }
    }

    const payload = toSavePayload(built.document, entry.baseVersion, flags.force);
    const res = await api.post(`/api/diagrams/${encodeURIComponent(entry.id)}/save`, payload, {
      // Bearer client: no browser Origin header, so the save route skips its
      // CSRF origin check for us.
    });

    if (!res.ok) {
      if (res.status === 401) return fail(flags.json, "AUTH_EXPIRED", "Login expired. Run `drawcms login` again.");
      if (res.error?.code === "CONFLICT" || res.status === 409) {
        results.push({
          name,
          status: "conflict",
          message: "server version moved; run `drawcms pull` then re-generate (or push --force)",
        });
        continue;
      }
      results.push({ name, status: "error", message: res.error?.message ?? `save failed (${res.status})` });
      continue;
    }

    // Persist the built document locally so the working copy matches what was
    // pushed, and record its hash as the new clean baseline.
    const { hash } = await writeDocument(name, built.document);
    entry.baseVersion = res.data.version ?? entry.baseVersion;
    entry.pulledHash = hash;
    changed = true;
    results.push({
      name,
      status: "pushed",
      diagramName: builtName,
      url: diagramUrl(origin, entry.id),
      version: res.data.version ?? null,
      warnings: built.validation?.issues?.length ?? 0,
      ...(stashedTo ? { stashedTo } : {}),
    });
  }

  // Record which commit the pushed diagrams reflect, so `status` can report
  // drift when new commits land afterward.
  if (changed) {
    const head = await headCommit();
    if (head) link.lastSyncedCommit = head;
    await writeProjectConfig(link);
  }

  const anyFail = results.some((r) => r.status !== "pushed");
  emit(
    {
      ok: !anyFail,
      command: "push",
      origin,
      lastSyncedCommit: link.lastSyncedCommit ?? null,
      results,
      render() {
        for (const r of results) {
          if (r.status === "pushed") {
            process.stdout.write(
              `↑ ${r.diagramName ?? r.name} — v${r.version}${r.warnings ? ` (${r.warnings} warning(s))` : ""}\n` +
                `  ${r.url}\n` +
                (r.stashedTo ? `  (overwrote cloud; previous revision stashed to ${r.stashedTo})\n` : ""),
            );
          } else if (r.status === "invalid") {
            process.stderr.write(`✗ ${r.name} invalid:\n`);
            for (const issue of r.issues ?? []) {
              process.stderr.write(`    ${issue.code}${issue.path ? ` at ${issue.path}` : ""}: ${issue.message}\n`);
            }
          } else {
            process.stderr.write(`✗ ${r.name} ${r.status}${r.message ? ` — ${r.message}` : ""}\n`);
          }
        }
      },
    },
    { json: flags.json },
  );
  process.exit(anyFail ? 1 : 0);
}

function fail(json, code, message) {
  emit(
    {
      ok: false,
      command: "push",
      error: { code, message },
      render() {
        process.stderr.write(`push failed (${code}): ${message}\n`);
      },
    },
    { json },
  );
  process.exit(1);
}
