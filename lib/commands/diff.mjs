// `drawcms diff` — read-only. Shows the code changes a diagram update should
// reflect: `git diff <lastSyncedCommit>..HEAD --stat` plus the changed file
// list, and which tracked diagrams have local edits since the last sync. This
// is the input an agent uses to decide what to re-generate before `push`.
//
// By default it does not fetch the server document: the diagram is a derived
// artifact, so the meaningful local diff is "what in the code changed" (drives
// regeneration) and "did I edit the local doc" (drives push), both answerable
// locally. `--against-cloud` opts into a network fetch and reports a
// node/edge-level delta between the local working copy and the current cloud
// document — the input for resolving a conflict before you decide to pull,
// `edit`, or push --force.

import { emit } from "../output.mjs";
import { createApi } from "../api.mjs";
import { readConfig, resolveAuthenticatedOrigin } from "../config.mjs";
import { readProjectConfig } from "../project.mjs";
import { readDocument } from "../docfile.mjs";
import { diffDocuments, renderDocDelta } from "../docdiff.mjs";
import { headCommit, isGitRepo, diffStatSince, changedFilesSince } from "../git.mjs";

const HELP = `drawcms diff [name] [--against-cloud] [--json]

Read-only. Shows:
  - git changes since the diagrams were last synced (diff --stat + file list)
  - which tracked diagrams have local edits since the last pull/push

  --against-cloud   Also fetch each tracked diagram's current cloud document and
                    report a node/edge-level delta against the local copy
                    (added/removed/changed nodes and edges, and layout-only
                    moves). Requires login; makes one request per diagram.
  [name]            With --against-cloud, restrict the comparison to this
                    logical diagram.

Use it to decide what to re-generate — or how to resolve a conflict — before
\`drawcms push\`.`;

export async function run({ flags, positional }) {
  if (flags.help) {
    process.stdout.write(HELP + "\n");
    process.exit(0);
  }

  const link = await readProjectConfig();
  if (!link) return fail(flags.json, "NOT_INITIALIZED", "Run `drawcms init` in this repo first.");

  const inRepo = await isGitRepo();
  const head = inRepo ? await headCommit() : null;
  const from = link.lastSyncedCommit ?? null;

  let stat = null;
  let changedFiles = null;
  let range = null;
  if (inRepo && from && head && from !== head) {
    stat = await diffStatSince(from);
    changedFiles = (await changedFilesSince(from)) ?? [];
    range = `${from.slice(0, 8)}..${head.slice(0, 8)}`;
  }

  const againstCloud = flags["against-cloud"] === true;
  const only = positional.length ? new Set(positional) : null;

  // Optional cloud fetch + structural delta.
  let api = null;
  let cloudError = null;
  if (againstCloud) {
    const config = await readConfig();
    if (!config.token) {
      return fail(flags.json, "NOT_LOGGED_IN", "Run `drawcms login` first (or drop --against-cloud).");
    }
    const resolved = resolveAuthenticatedOrigin(flags, config, link.origin);
    if (!resolved.ok) return fail(flags.json, resolved.code, resolved.message);
    if (resolved.crossOrigin && !flags.origin && !process.env.DRAWCMS_ALLOW_CROSS_ORIGIN) {
      return fail(
        flags.json,
        "CROSS_ORIGIN_TOKEN",
        `This repo is bound to ${resolved.origin}, but you logged in at ${resolved.loginOrigin}. ` +
          `Comparing against cloud would send that session token to a different server. If that is intended, ` +
          `re-run with --origin ${resolved.origin} or set DRAWCMS_ALLOW_CROSS_ORIGIN=1.`,
      );
    }
    api = createApi({ origin: resolved.origin, token: config.token });
  }

  const diagrams = [];
  for (const [name, entry] of Object.entries(link.diagrams ?? {})) {
    if (only && !only.has(name)) continue;
    const local = await readDocument(name);
    const modified = Boolean(local && entry.pulledHash && local.hash !== entry.pulledHash);
    const record = { name, modified, present: Boolean(local) };

    if (againstCloud) {
      if (!local || !local.document) {
        record.cloud = { status: "no-local", message: "no local document to compare (pull or author it first)" };
      } else {
        const res = await api.get(`/api/diagrams/${encodeURIComponent(entry.id)}/document`);
        if (!res.ok) {
          if (res.status === 401) {
            return fail(flags.json, "AUTH_EXPIRED", "Login expired. Run `drawcms login` again.");
          }
          cloudError = true;
          record.cloud = { status: "error", message: res.error?.message ?? `fetch failed (${res.status})` };
        } else {
          const delta = diffDocuments(local.document, res.data.document);
          record.cloud = {
            status: delta.hasChanges ? "diverged" : "identical",
            version: res.data.version ?? null,
            baseVersion: entry.baseVersion ?? null,
            behindServer:
              entry.baseVersion != null && res.data.version != null && res.data.version > entry.baseVersion,
            delta,
          };
        }
      }
    }

    diagrams.push(record);
  }

  emit(
    {
      ok: !cloudError,
      command: "diff",
      git: {
        isRepo: inRepo,
        head,
        lastSyncedCommit: from,
        range,
        changedFiles: changedFiles ?? undefined,
        stat: stat ?? undefined,
      },
      diagrams,
      render() {
        if (!inRepo) {
          process.stdout.write("(not a git repo — code diff unavailable)\n");
        } else if (!from) {
          process.stdout.write("No lastSyncedCommit yet — push a diagram to establish a baseline.\n");
        } else if (!range) {
          process.stdout.write("No new commits since the diagrams were last synced.\n");
        } else {
          process.stdout.write(`code changes ${range}:\n`);
          process.stdout.write(stat ? stat + "\n" : "");
        }
        const modified = diagrams.filter((d) => d.modified).map((d) => d.name);
        if (modified.length) {
          process.stdout.write(`locally modified diagrams: ${modified.join(", ")}\n`);
        }
        if (againstCloud) {
          for (const d of diagrams) {
            const c = d.cloud;
            if (!c) continue;
            if (c.status === "error") {
              process.stderr.write(`✗ ${d.name} — cloud fetch failed: ${c.message}\n`);
            } else if (c.status === "no-local") {
              process.stdout.write(`• ${d.name} — ${c.message}\n`);
            } else if (c.status === "identical") {
              process.stdout.write(`= ${d.name} — local matches cloud (v${c.version})\n`);
            } else {
              const behind = c.behindServer ? " — cloud moved past your baseVersion (conflict on push)" : "";
              process.stdout.write(`≠ ${d.name} — diverged from cloud (v${c.version})${behind}:\n`);
              process.stdout.write(renderDocDelta(c.delta));
            }
          }
        }
      },
    },
    { json: flags.json },
  );
  process.exit(cloudError ? 1 : 0);
}

function fail(json, code, message) {
  emit(
    {
      ok: false,
      command: "diff",
      error: { code, message },
      render() {
        process.stderr.write(`diff failed (${code}): ${message}\n`);
      },
    },
    { json },
  );
  process.exit(1);
}
