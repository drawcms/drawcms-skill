# Reading a repository into a diagram

How to turn a real codebase into a DrawCMS diagram that is true to the code.
The goal is a communication artifact, not an exhaustive map: one clear main
path, the components that matter, and honest relationships.

## First run — whole repo

1. **Establish what the system is.** Read the manifest(s) — `package.json`,
   `pyproject.toml`/`requirements.txt`, `go.mod`, `Cargo.toml`, `pom.xml`,
   `Dockerfile`, `docker-compose.yml`, `*.tf`, Helm/k8s manifests. They name the
   language, framework, services, and external dependencies faster than reading
   source.
2. **Find the entry points.** `main`/`index`/`server` files, HTTP route
   registrations, CLI entry points, queue consumers, cron/worker definitions.
   These anchor the primary path.
3. **Identify the moving parts** and map each to a node type
   (see `references/vocabulary.md`):
   - user-facing app or client → `arch-frontend`
   - a service/API/worker → `arch-backend`
   - a datastore, cache, or queue → `arch-database` / `arch-messagebus`
   - an external/third-party API → `arch-external`
   - auth/gateway/security control → `arch-security`
   - **a named product → its brand element, not the generic category.** If the
     manifest, image, SDK, or IaC names Redis, Postgres, Kafka's rabbit,
     Kubernetes, S3, BigQuery, Cosmos DB, and so on, use the matching
     `infra-*` / `aws-*` / `gcp-*` / `azure-*` element so it renders as that
     logo. The full table is in `references/vocabulary.md`. To resolve a batch
     of labels to `infra-*` elements at once, write them to a JSON file and run
     `drawcms recommend entities.json` — then **confirm each suggestion against
     the code**. It keys off label words only, so it will happily map
     "Postgres-compatible layer" to `infra-postgresql`; a brand icon the code
     does not justify is worse than a correct generic box. When no specific
     product is named, keep the generic category.
4. **Trace the primary path.** Follow one representative request or job from
   its entry point through the services it touches to the datastore and back.
   That path is the spine of the diagram; everything else is a short branch off
   it.
5. **Choose the diagram type** with the router in SKILL.md. "How is it built"
   → `architecture`. "What happens when X calls Y" → `sequence`. A pipeline →
   `data-flow`. A process with gates → `flowchart`. A state machine →
   `lifecycle`.
6. **Author the spec** with ≤ ~12 primary nodes. Omit positions (let layout
   run) — it ranks nodes into tiers and reduces crossings, which is how you
   convey grouping. Do **not** wrap groups in `boundary-*` frames: they do not
   contain nodes and render as empty/overlapping boxes (see the grouping rule in
   SKILL.md). Label edges with the real protocol/action. **Include `beats`** —
   an ordered walkthrough of the flow you just traced, one beat per meaningful
   step, titles/descriptions from the code — so the diagram ships with a guided
   story by default (animated; pass `--static` for a still diagram). Do not add a
   component, edge, or beat you cannot point to in the code.
7. **Validate, fix, push** per the SKILL.md fast path.

## What to leave out

- Build tooling, linters, test frameworks, and formatters — unless the diagram
  is specifically about CI/CD.
- Every table and every function. Show the datastore, not its schema (unless a
  `database-model` diagram was requested).
- Speculative or aspirational components. Diagram the code that exists.

## Updating after code changes

Reflect the delta; do not regenerate blindly.

1. `drawcms diff` lists the files changed since the diagram was last synced.
   Read those changes.
2. Map the change to a diagram edit:
   - a new service/module → add one node and wire its real edges
   - a removed component → delete its node and dangling edges
   - a renamed component → update the `label` (keep the `id` stable if it still
     denotes the same thing, so layout and history stay coherent)
   - a new dependency/call → add one edge with a real label
3. `drawcms pull` first if the cloud copy may have changed, then apply the edit
   to `.drawcms/<name>.json`, preserving untouched nodes/edges and their ids.
4. `drawcms build … --json`, resolve issues, `drawcms push`.

## Multiple diagrams per repo

A repo can track several diagrams (e.g. `architecture` plus a `sequence` for
the auth flow). `drawcms init --diagram <name> --type <type>` on a fresh repo,
or create more diagrams in the cloud and add matching keys under `diagrams` in
`.drawcms/config.json`. Each diagram has its own `.drawcms/<name>.json`.
