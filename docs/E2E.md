# End-to-end verification

Two levels of verification exist for this skill:

1. **Automated (in the test suite).** `test/e2e.test.mjs` drives the real
   `drawcms` CLI binary through the entire loop — login → init → author →
   build → push → pull → status → diff — against a single fake server that
   implements every endpoint the CLI touches, including real optimistic-
   concurrency semantics on save. The individual endpoint contracts are covered
   against the real cloud handlers in the `drawcms-cloud` test suite (device
   auth, bearer, `/api/v1/*`, and the document/save routes). Run it with
   `npm test`.

2. **Live (manual).** The steps below run the CLI against the actual
   `drawcms-cloud` app on the local Cloudflare Miniflare stack. This exercises
   real Better Auth device flow (with a real browser approval), real D1, and
   the real OpenNext Worker — the one seam a headless test cannot cover because
   it needs a human to approve the device code in a browser.

   For the faster `next dev` path (same API routes, quicker iteration) plus the
   two local-only gotchas — the `deviceCode` schema and the verified-email gate
   — see [`LOCAL-TESTING.md`](./LOCAL-TESTING.md).

## Live run against `preview:cloudflare`

In `drawcms-cloud/`:

```bash
cp .dev.vars.example .dev.vars     # set BETTER_AUTH_SECRET + APP_URL at minimum
npm run db:push                    # apply src/db/schema.sql (incl. the deviceCode table) to local D1
npm run preview:cloudflare         # full stack on http://localhost:3000
```

Create an account in the browser at `http://localhost:3000/signup` (the device
flow adopts an existing signed-in session to approve).

In this skill folder, pointed at the local server:

```bash
export DRAWCMS_ORIGIN=http://localhost:3000
npm run build:engine               # once, if lib/engine.mjs is not built
npm link                           # put `drawcms` on PATH (or call bin/drawcms.mjs directly)

# In a sample repo (any fullstack app):
drawcms login                      # opens /device; approve the shown code in the browser
drawcms init                       # binds the repo, creates an "architecture" diagram
#   ...author .drawcms/architecture.json from the repo (this is the agent's job)...
drawcms build architecture .drawcms/architecture.json --json
drawcms push                       # saves to the cloud project
drawcms status                     # should report clean, at HEAD
```

Open `http://localhost:3000/dashboard` — the diagram appears in the project the
repo was linked to. Make a code change, commit, and:

```bash
drawcms diff                       # shows what changed since the last sync
#   ...apply a focused edit to .drawcms/architecture.json...
drawcms push                       # updates the same cloud diagram
```

## Notes

- The device code is single-use and expires in 15 minutes; `drawcms login`
  polls until you approve it in the browser.
- `drawcms login --no-browser` prints the approval URL instead of opening it —
  useful on a headless host (open the URL on another machine).
- Point at production with `DRAWCMS_ORIGIN=https://drawcms.com` (or omit it —
  that is the default).
