// `drawcms status` — read-only summary of how the repo's diagrams relate to
// the cloud and to the code. For each tracked diagram it reports whether the
// local working copy was edited since the last pull/push, and whether the repo
// has moved past the commit the diagrams were last synced from ("behind latest
// commit"). No network call and no cloud changes — it reads .drawcms/ and git.

import { emit } from "../output.mjs";
import { readProjectConfig } from "../project.mjs";
import { readDocument } from "../docfile.mjs";
import { headCommit, isGitRepo, changedFilesSince } from "../git.mjs";

const HELP = `drawcms status [--json]

Shows, without contacting the server:
  - which tracked diagrams have local edits since the last pull/push
  - whether the repo has new commits since the diagrams were last synced

Read-only. Run \`drawcms pull\`/\`push\` to act on what it reports.`;

export async function run({ flags }) {
  if (flags.help) {
    process.stdout.write(HELP + "\n");
    process.exit(0);
  }

  const link = await readProjectConfig();
  if (!link) {
    return emitStatus(flags.json, {
      ok: true,
      linked: false,
      message: "This repo is not linked. Run `drawcms init`.",
      diagrams: [],
    });
  }

  const inRepo = await isGitRepo();
  const head = inRepo ? await headCommit() : null;
  const lastSynced = link.lastSyncedCommit ?? null;

  // Repo-level: has code moved since the diagrams were last synced?
  let commitsBehind = null; // null = unknown (not a git repo / never synced)
  let changedFiles = null;
  if (inRepo && lastSynced && head) {
    if (lastSynced === head) {
      commitsBehind = 0;
    } else {
      changedFiles = (await changedFilesSince(lastSynced)) ?? [];
      commitsBehind = changedFiles.length; // proxy: number of changed files
    }
  }

  const diagrams = [];
  for (const [name, entry] of Object.entries(link.diagrams ?? {})) {
    const local = await readDocument(name);
    let local_state;
    if (!local) local_state = "missing";
    else if (!entry.pulledHash) local_state = "untracked-hash";
    else if (local.hash !== entry.pulledHash) local_state = "modified";
    else local_state = "clean";

    diagrams.push({
      name,
      id: entry.id,
      type: entry.type ?? null,
      baseVersion: entry.baseVersion ?? null,
      local: local_state,
    });
  }

  const behind = inRepo && lastSynced && head ? lastSynced !== head : false;

  emitStatus(flags.json, {
    ok: true,
    linked: true,
    workspace: { id: link.teamId, name: link.teamName ?? null },
    project: { id: link.projectId, name: link.projectName ?? null },
    git: {
      isRepo: inRepo,
      head,
      lastSyncedCommit: lastSynced,
      behind,
      changedFiles: changedFiles ?? undefined,
    },
    diagrams,
  });
}

function emitStatus(json, payload) {
  emit(
    {
      ...payload,
      command: "status",
      render() {
        if (!payload.linked) {
          process.stdout.write(payload.message + "\n");
          return;
        }
        process.stdout.write(
          `project: ${payload.project.name ?? payload.project.id} (workspace ${
            payload.workspace.name ?? payload.workspace.id
          })\n`,
        );
        if (payload.git.isRepo) {
          if (!payload.git.lastSyncedCommit) {
            process.stdout.write("git: diagrams have never been pushed (no lastSyncedCommit)\n");
          } else if (payload.git.behind) {
            const n = payload.git.changedFiles?.length ?? 0;
            process.stdout.write(
              `git: repo has moved since last sync (${n} file(s) changed) — diagrams may be stale\n`,
            );
          } else {
            process.stdout.write("git: diagrams reflect the current HEAD\n");
          }
        }
        process.stdout.write("diagrams:\n");
        for (const d of payload.diagrams) {
          process.stdout.write(`  ${localMark(d.local)} ${d.name} [${d.type ?? "?"}] v${d.baseVersion ?? "?"} (${d.local})\n`);
        }
      },
    },
    { json },
  );
  process.exit(0);
}

function localMark(state) {
  if (state === "clean") return "✓";
  if (state === "modified") return "*";
  if (state === "missing") return "?";
  return "•";
}
