// `drawcms init` — bind the current repo to a DrawCMS workspace + project and
// (by default) create an initial diagram, writing the link to
// <repo>/.drawcms/config.json. Flag-driven so terminal agents can run it
// non-interactively; sensible defaults (personal workspace, project named after
// the repo, one architecture diagram) apply when flags are omitted.

import { emit } from "../output.mjs";
import { createApi } from "../api.mjs";
import { readConfig, resolveOrigin, assertSafeOrigin, diagramUrl } from "../config.mjs";
import { emptyProjectConfig, ensureProjectGitignore, readProjectConfig, writeProjectConfig } from "../project.mjs";
import { projectLabel } from "../git.mjs";
import { PRIMARY_DIAGRAM_TYPES } from "../build.mjs";

const HELP = `drawcms init [options]

Binds this repository to a DrawCMS project and creates an initial diagram.
Writes .drawcms/config.json in the current directory.

  --team <id>            Workspace (team) id. Default: your personal workspace.
  --project <id>         Use an existing project by id.
  --project-name <name>  Create a new project with this name. Default: the repo
                         name (git toplevel or directory basename). The project
                         represents the repo, so keep it repo-scoped — put the
                         diagram's subject on the diagram, not here.
  --diagram <name>       Logical name for the first diagram (default: "architecture").
  --type <type>          First diagram type: ${PRIMARY_DIAGRAM_TYPES.join(" | ")} (default: architecture).
  --no-diagram           Bind the project only; do not create a diagram yet.
  --force                Overwrite an existing .drawcms/config.json.
  --origin <url>         Server origin (default: stored login origin).`;

export async function run({ flags }) {
  if (flags.help) {
    process.stdout.write(HELP + "\n");
    process.exit(0);
  }

  const existing = await readProjectConfig();
  if (existing && !flags.force) {
    return fail(flags.json, "ALREADY_INITIALIZED", "This repo is already linked (use --force to relink).");
  }

  const config = await readConfig();
  if (!config.token) {
    return fail(flags.json, "NOT_LOGGED_IN", "Run `drawcms login` first.");
  }
  const origin = resolveOrigin(flags, config);
  const safe = assertSafeOrigin(origin);
  if (!safe.ok) return fail(flags.json, safe.code, safe.message);
  const api = createApi({ origin, token: config.token });

  // 1. Resolve the workspace.
  const wsRes = await api.get("/api/v1/workspaces");
  if (!wsRes.ok) {
    if (wsRes.status === 401) return fail(flags.json, "AUTH_EXPIRED", "Login expired. Run `drawcms login` again.");
    return fail(flags.json, "WORKSPACES_FAILED", wsRes.error?.message ?? "Could not list workspaces.");
  }
  const workspaces = wsRes.data.workspaces ?? [];
  let team;
  if (flags.team) {
    team = workspaces.find((w) => w.id === flags.team);
    if (!team) return fail(flags.json, "UNKNOWN_TEAM", `You are not a member of workspace ${flags.team}.`);
  } else {
    // Default: the personal workspace (slug starts with "personal-"), else the
    // first workspace the user can write to.
    team =
      workspaces.find((w) => String(w.slug).startsWith("personal-")) ||
      workspaces.find((w) => w.role !== "viewer") ||
      workspaces[0];
    if (!team) return fail(flags.json, "NO_WORKSPACE", "No writable workspace found on your account.");
  }

  // 2. Resolve the project (existing by id, or create one).
  let project;
  if (flags.project) {
    const listRes = await api.get(`/api/v1/projects?teamId=${encodeURIComponent(team.id)}`);
    if (!listRes.ok) return fail(flags.json, "PROJECTS_FAILED", listRes.error?.message ?? "Could not list projects.");
    project = (listRes.data.projects ?? []).find((p) => p.id === flags.project);
    if (!project) return fail(flags.json, "UNKNOWN_PROJECT", `Project ${flags.project} not found in this workspace.`);
  } else {
    const name = flags["project-name"] || (await projectLabel()) || "Untitled Project";
    const createRes = await api.post("/api/v1/projects", { teamId: team.id, name });
    if (!createRes.ok) return fail(flags.json, "PROJECT_CREATE_FAILED", createRes.error?.message ?? "Could not create the project.");
    project = { id: createRes.data.project.id, name };
  }

  // 3. Build the repo link and (optionally) create the first diagram.
  const linked = emptyProjectConfig({
    origin,
    teamId: team.id,
    teamName: team.name,
    projectId: project.id,
    projectName: project.name,
  });

  let createdDiagram = null;
  if (!flags["no-diagram"]) {
    const type = flags.type || "architecture";
    if (!PRIMARY_DIAGRAM_TYPES.includes(type)) {
      return fail(flags.json, "UNKNOWN_TYPE", `Unknown --type "${type}". Use one of: ${PRIMARY_DIAGRAM_TYPES.join(", ")}.`);
    }
    const logicalName = flags.diagram || "architecture";
    const diagRes = await api.post("/api/v1/diagrams", { teamId: team.id, projectId: project.id });
    if (!diagRes.ok) {
      return fail(flags.json, "DIAGRAM_CREATE_FAILED", diagRes.error?.message ?? "Could not create the diagram.");
    }
    // baseVersion starts null; a subsequent `pull` records the server version.
    linked.diagrams[logicalName] = { id: diagRes.data.diagram.id, type, baseVersion: null };
    createdDiagram = { name: logicalName, id: diagRes.data.diagram.id, type };
  }

  const path = await writeProjectConfig(linked);
  await ensureProjectGitignore();

  const diagramWithUrl = createdDiagram
    ? { ...createdDiagram, url: diagramUrl(origin, createdDiagram.id) }
    : null;

  emit(
    {
      ok: true,
      command: "init",
      origin,
      workspace: { id: team.id, name: team.name },
      project: { id: project.id, name: project.name },
      diagram: diagramWithUrl,
      configPath: path,
      render() {
        process.stdout.write(`Linked this repo to project "${project.name}" in "${team.name}".\n`);
        if (diagramWithUrl) {
          process.stdout.write(
            `Created ${diagramWithUrl.type} diagram (${diagramWithUrl.id}):\n  ${diagramWithUrl.url}\n` +
              `Give it a real title with a "name" in the spec before you push — it is currently untitled.\n`,
          );
        }
        process.stdout.write(`Wrote ${path}\n`);
      },
    },
    { json: flags.json },
  );
  process.exit(0);
}

function fail(json, code, message) {
  emit(
    {
      ok: false,
      command: "init",
      error: { code, message },
      render() {
        process.stderr.write(`init failed (${code}): ${message}\n`);
      },
    },
    { json },
  );
  process.exit(1);
}
