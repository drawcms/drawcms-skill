# drawcms — repo-to-DrawCMS diagram skill

An agent skill + git-like CLI that turns a code repository into maintained
[DrawCMS](https://drawcms.com) diagrams — architecture, workflow, sequence,
data-flow, and lifecycle — synced to a DrawCMS cloud project.

The agent reads the repo and authors typed JSON; the `drawcms` CLI validates it
against the real DrawCMS engine and syncs it. Works from any terminal agent
(Claude Code, Codex, OpenCode, OpenClaw, Hermes) because the whole interface is
a shell command.

## What it does

```
drawcms login     # device-flow browser sign-in (stores a token)
drawcms init      # bind this repo to a DrawCMS project + create a diagram
drawcms build     # validate an authored spec headlessly (no network)
drawcms pull      # fetch the cloud document(s) into .drawcms/
drawcms push      # validate + save local document(s) to the cloud (fail-closed)
drawcms status    # local edits + whether diagrams lag behind the latest commit
drawcms diff      # code changes since last sync + locally modified diagrams
drawcms doctor    # environment + engine check
```

The full authoring contract for agents is in [`SKILL.md`](./SKILL.md).

## Requirements

- Node.js ≥ 18.
- A DrawCMS account (the CLI signs you in via the browser; no API key).

## Fetch the engine

The CLI needs the DrawCMS diagram engine at `lib/engine.mjs` — a prebuilt bundle
published as a release asset on the editor repo. Fetch it once (it verifies a
pinned SHA-256):

```bash
npm install
npm run fetch-engine      # downloads lib/engine.mjs from the pinned release, checksum-verified
npm run check:engine      # CI: fails if lib/engine.mjs is missing or does not match the pin
drawcms doctor            # confirms Node + engine
```

Maintainers rebuilding the engine from editor source instead of downloading it
can use `npm run build:engine` (needs a packed `@drawcms/editor` release, e.g.
`DRAWCMS_EDITOR_TGZ=/path/to.tgz npm run build:engine`), then bump the pin in
`scripts/fetch-engine.mjs`.

## Install as an agent skill

The skill is one self-contained folder. There are two ways to install it.

### Quick: `npx skills add`

```bash
npx skills add drawcms/drawcms-skill -g       # drop -g for the current project only
```

This installs the whole skill folder — `SKILL.md`, references, **and** the CLI
(`bin/`, `lib/`, `scripts/`) — into your agents via the
[open skills CLI](https://github.com/vercel-labs/skills). It does not download
the engine bundle (the AGPL-3.0 engine from `@drawcms/editor` is deliberately
not committed to this MIT repo), so that is fetched on first use:

```bash
# The agent does this automatically on an ENGINE_MISSING error. To do it yourself,
# run it from wherever the skill was installed, e.g.:
node ~/.claude/skills/drawcms/scripts/fetch-engine.mjs   # checksum-verified download
```

No `git clone` or `npm install` is needed to *use* the skill: `fetch-engine.mjs`
and the CLI run on Node ≥18 alone (the engine bundle carries its own deps
inlined). Until the engine is fetched, engine-dependent commands (`build`,
`push`, `local`, `edit`, `grammar`) return a clear `ENGINE_MISSING` error telling
the agent to run `fetch-engine`. `login`/`init`/`pull`/`status`/`diff` work
without it.

### Manual: copy or symlink the folder

Copy it (or a packaged zip — see
`npm run package`) into the agent's skills directory. Paths verified as of
writing; check each agent's docs if a version differs.

| Agent | Install location |
|---|---|
| Claude Code | `~/.claude/skills/drawcms/` (or `.claude/skills/drawcms/` per-project) |
| Codex CLI | `~/.agents/skills/drawcms/` or `~/.codex/skills/drawcms/` |
| OpenCode | `~/.config/opencode/skills/drawcms/`, `.opencode/skills/drawcms/`, or `.agents/skills/drawcms/` |
| OpenClaw | `~/.openclaw/workspace/skills/drawcms/` |
| Hermes | `~/.hermes/skills/drawcms/` |

### Recommended: one canonical copy, symlinked everywhere

`~/.agents/skills/` is the shared convention several CLI agents read, so install
there once and point the others at it. Symlinking (rather than copying) means
edits to the skill take effect immediately — the right choice while developing
or testing.

```bash
SKILL_DIR="$PWD"                                    # run from this folder

# canonical location
ln -sfn "$SKILL_DIR" ~/.agents/skills/drawcms

# the rest point at it (relative links, so they survive a $HOME move)
ln -sfn ../../.agents/skills/drawcms ~/.claude/skills/drawcms
ln -sfn ../../.agents/skills/drawcms ~/.codex/skills/drawcms

mkdir -p ~/.config/opencode/skills
ln -sfn "$SKILL_DIR" ~/.config/opencode/skills/drawcms

# OpenClaw / Hermes, if installed
mkdir -p ~/.openclaw/workspace/skills ~/.hermes/skills
ln -sfn "$SKILL_DIR" ~/.openclaw/workspace/skills/drawcms
ln -sfn "$SKILL_DIR" ~/.hermes/skills/drawcms
```

For distribution to other machines, ship a copy instead:

```bash
npm run package                       # dist/drawcms/ + dist/drawcms-skill.zip
cp -R dist/drawcms ~/.claude/skills/drawcms
```

### Put `drawcms` on PATH

Installing a skill folder does not put its binary on `PATH`. `SKILL.md` teaches
agents to fall back to `node <skill-folder>/bin/drawcms.mjs`, so the skill works
either way — but the short form is nicer:

```bash
npm link                              # from this folder
drawcms doctor                        # expect: node OK, engine OK
```

Verify an agent can read the skill:

```bash
grep -m1 '^name:' ~/.claude/skills/drawcms/SKILL.md    # -> name: drawcms
```

### Uninstall

```bash
rm ~/.agents/skills/drawcms ~/.claude/skills/drawcms ~/.codex/skills/drawcms \
   ~/.config/opencode/skills/drawcms
npm unlink -g drawcms-skill
```

## Layout

```
SKILL.md                 # the agent contract (frontmatter + instructions)
bin/drawcms.mjs          # CLI entrypoint (git-like commands)
lib/                     # command implementations + the bundled engine
examples/                # one authored spec per diagram type
references/              # analysis method + vocabulary (read on demand)
scripts/fetch-engine.mjs # downloads lib/engine.mjs (checksum-verified) from the editor release
skill-release.json       # skill id + version metadata
```

## Configuration

- Global: `~/.drawcms/config.json` holds the auth token + default origin (0600).
- Per-repo: `<repo>/.drawcms/config.json` links the repo to a workspace/project
  and tracks each diagram's id, version, and last-synced commit. It also holds
  the local `.drawcms/<name>.json` document files.
- Point at a non-default server with `--origin <url>` or `DRAWCMS_ORIGIN`.

## License

MIT — see [`LICENSE`](./LICENSE). This covers the skill instructions and the
`drawcms` CLI wrapper in this repository.

The diagram engine the CLI bundles at build time (`lib/engine.mjs`, generated by
`npm run build:engine`) is derived from [`@drawcms/editor`](https://drawcms.com),
which is **AGPL-3.0-only**. That bundle is generated locally on your machine and
is **not** committed or redistributed by this MIT repository — which is why
`build:engine` is a required setup step rather than a shipped artifact. If you
redistribute a build that includes the generated engine, the AGPL-3.0 terms
apply to that combined distribution.
