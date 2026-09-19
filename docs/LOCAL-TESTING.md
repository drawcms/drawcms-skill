# Testing the skill against a local drawcms-cloud

Primary path: **Miniflare** (`npm run preview:cloudflare`) — the full Workers
stack with real D1, KV, and R2, which is what the app actually runs on. A
faster-iteration alternative using `next dev` is at the end.

Assumes the repos are siblings: `drawcms-cloud/` and `drawcms-skill/`.

## 0. One-time prep

**Schema.** `deviceCode` (the device-flow table) ships with this feature, so a
database created before it does not have the table. Apply the schema:

```bash
cd drawcms-cloud
npm run db:push
```

This is the only migration needed for local work: `next dev` and
`preview:cloudflare` share one Miniflare D1. (`.local/d1.sqlite` / `db:init` is
the vitest database and is not used by either server.)

Verify:

```bash
npx wrangler d1 execute drawcms-db --local \
  --command "select name from sqlite_master where type='table' and name='deviceCode';"
```

**Env.** Miniflare reads `.dev.vars` (not `.env*`). It needs at minimum:

```
BETTER_AUTH_SECRET=<any long random string>
APP_URL=http://localhost:3000
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

`APP_URL` matters specifically here: Better Auth's `baseURL` and the device
flow's `verification_uri` are built from it. A production value would send your
browser to the wrong host to approve.

**Skill engine.** Generated and gitignored, so a fresh checkout has none:

```bash
cd ../drawcms-skill
npm install
npm run build:engine
node bin/drawcms.mjs doctor        # expect: node OK, engine OK
```

## 1. Build, then serve

`opennextjs-cloudflare preview` serves an **already-built** app — it does not
build. Any change to cloud source (including the device-flow work) needs a
rebuild first:

```bash
cd drawcms-cloud
npm run build:cloudflare          # next build + opennext build
npm run preview:cloudflare        # Miniflare on http://localhost:3000
```

A `BetterAuthError: default secret` during the **build** step is expected — the
secret is a runtime value from `.dev.vars`, not a build-time one.

Leave the preview running in its own terminal.

## 2. Use an account that can create diagrams

Two gates apply to diagram creation, and both bite locally:

1. **Verified email.** `requireVerifiedEmail` blocks creation unless
   `user.emailVerified` is set. Locally no transactional email provider is
   configured, so the confirmation mail is only logged — there is no link to
   click. Accounts created via Google/GitHub arrive verified; email/password
   accounts do not.
2. **Free-plan diagram cap.** A free workspace allows 3 diagrams. A workspace
   already at the cap returns `RATE_LIMITED` from `drawcms init`.

Check where you stand:

```bash
cd drawcms-cloud
npx wrangler d1 execute drawcms-db --local --command "
select u.email, u.emailVerified, t.name as team, t.id as team_id,
       (select count(*) from diagrams d where d.team_id = t.id) as diagrams,
       coalesce(s.plan,'free') as plan
from team_members tm
join user u on u.id = tm.user_id
join teams t on t.id = tm.team_id
left join subscriptions s on s.team_id = t.id;"
```

Then pick one:

- **Verified but at the cap** — delete a diagram in the dashboard to free a
  slot, or run `drawcms init --no-diagram` and add an existing diagram's id to
  `.drawcms/config.json` by hand (see step 4) to exercise pull/push without
  creating anything.
- **Unverified but has room** — flip the flag for that address:

  ```bash
  npx wrangler d1 execute drawcms-db --local \
    --command "update user set emailVerified = 1 where email = 'you@example.test';"
  ```

- **Neither** — sign up at <http://localhost:3000/signup>, then flip as above.

Whichever account you use, **sign in to it in the browser and stay signed in** —
the device flow adopts that session to approve the CLI.

## 3. Sign the CLI in

```bash
cd drawcms-skill
export DRAWCMS_ORIGIN=http://localhost:3000
node bin/drawcms.mjs login
```

It prints a code and opens <http://localhost:3000/device>. Confirm the code
matches your terminal, click **Approve**, and the CLI completes:
`Logged in as you@example.test (http://localhost:3000).`

The token is written to `~/.drawcms/config.json` (mode 0600). To keep it away
from a real production login, prefix commands with
`DRAWCMS_CONFIG_HOME=/tmp/drawcms-local`.

## 4. Link a repo and author a diagram

In whatever repo you want to diagram:

```bash
cd /path/to/some-repo
drawcms init                      # creates a project + an "architecture" diagram
```

`.drawcms/config.json` records the workspace, project, diagram id, and
`origin: http://localhost:3000`. The repo's origin outranks the global one, so
later commands stay on localhost even after you log in to production.

Targeting a specific workspace, or attaching to an existing diagram instead of
creating one:

```bash
drawcms init --team <team_id>              # skip workspace auto-pick
drawcms init --no-diagram                  # link the project only
# then add to .drawcms/config.json:
#   "diagrams": { "architecture": { "id": "<existing diagram uuid>",
#                                   "type": "architecture", "baseVersion": null } }
drawcms pull                               # fetch it into .drawcms/architecture.json
```

Author the spec (in real use the agent writes this from the code):

```bash
cat > .drawcms/architecture.json <<'JSON'
{
  "diagramType": "architecture",
  "nodes": [
    { "id": "web", "label": "Next.js app", "type": "arch-frontend" },
    { "id": "api", "label": "API routes",  "type": "arch-backend" },
    { "id": "db",  "label": "D1",          "type": "arch-database" }
  ],
  "edges": [
    { "source": "web", "target": "api", "label": "HTTPS" },
    { "source": "api", "target": "db",  "label": "SQL" }
  ]
}
JSON

drawcms build architecture .drawcms/architecture.json --json
drawcms push
drawcms status
```

## 5. Verify it landed

Open <http://localhost:3000/dashboard> — the diagram is in the project named
after your repo. Or query directly:

```bash
cd drawcms-cloud
npx wrangler d1 execute drawcms-db --local --command "
select d.name, d.version, d.payload_r2_key is not null as in_r2, p.name as project
from diagrams d left join projects p on p.id = d.project_id
order by d.updated_at desc limit 5;"
```

`in_r2 = 1` is expected: Miniflare provides a real R2 binding, so
`persistDiagramPayload` stores the payload as an object and the row keeps only
the pointer. (Under `next dev` there is no R2 binding and payloads stay in the
JSON columns — both paths are supported.)

Request-level tracing while the preview runs:

```bash
npm run observe:local -- --routes
npm run observe:local -- --logs device
```

## 6. Exercise the update loop

```bash
cd /path/to/some-repo
echo "// worker" > worker.js && git add . && git commit -qm "add worker"

drawcms status                    # reports the repo moved past the last sync
drawcms diff                      # lists worker.js as the change to reflect
# add a node for the worker to .drawcms/architecture.json, then:
drawcms push
```

For the conflict path, edit the diagram in the browser editor (bumping its
version), then push again — it refuses with
`conflict — run drawcms pull then re-generate`. Run `drawcms pull` and re-apply.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `/device` 404s | preview is serving a stale build — `npm run build:cloudflare` |
| `no such table: deviceCode` | `npm run db:push` |
| `FORBIDDEN — Confirm your email address first` | step 2's `emailVerified` flip |
| `RATE_LIMITED` on init | workspace at the free 3-diagram cap — delete one, or `--team` another workspace |
| `ENGINE_MISSING` | `npm run build:engine` in `drawcms-skill/` |
| `login` opens the wrong host | `APP_URL` in `.dev.vars` is not `http://localhost:3000` |
| `AUTH_EXPIRED` on pull/push | token no longer valid — `drawcms login` again |
| requests hit `drawcms.com` unexpectedly | `DRAWCMS_ORIGIN` unset and the repo has no `.drawcms/config.json` — re-run `init` or pass `--origin` |
| `CONFIG_CORRUPT` / `PROJECT_CONFIG_CORRUPT` | the named JSON file is malformed; the message includes the remedy |
| `BetterAuthError: default secret` during build | expected; runtime secret comes from `.dev.vars` |
| `429 Too Many Requests` from `/api/auth/*` | Better Auth resolves the client IP from `cf-connecting-ip`, which no local server sends, so every caller shares one rate-limit bucket. Space out repeated auth calls (scripted tests especially) or restart the server to clear it. |

## Faster alternative: `next dev`

`next dev` starts in about a second and needs no build, because
`initOpenNextCloudflareForDev()` in `next.config.ts` wires the **same
Miniflare bindings** into it:

```bash
cd drawcms-cloud
npm run dev                       # http://localhost:3000
```

It shares the same D1, KV, and R2 as `preview:cloudflare` — so `npm run db:push`
covers both, diagram payloads go to R2 in both, and an account created in one is
visible in the other. Env comes from `.env.development.local` instead of
`.dev.vars`.

`.local/d1.sqlite` and `npm run db:init` are **not** used by either server —
they exist for the vitest suite only (`src/db/client.ts` gates that path on
`VITEST`). Always target the running server's database by binding name:

```bash
npx wrangler d1 execute drawcms-db --local --command "<sql>"
```

The only difference from preview mode is fidelity: `next dev` runs your routes
in Node rather than in workerd, so it will not catch Worker-runtime-specific
problems. Do a `preview:cloudflare` pass before shipping.
