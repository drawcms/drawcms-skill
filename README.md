<h1 align="center">drawcms</h1>

<h3 align="center">Point your agent at a repository. Get a maintained diagram of it.</h3>

<p align="center">An agent skill plus a git-like CLI. The agent reads your codebase and authors typed JSON; the <code>drawcms</code> command validates it against the real DrawCMS engine and keeps it in sync — as a cloud project, or as a file for a self-hosted editor. Works from any terminal agent, because the whole interface is a shell command.</p>

<p align="center">
  <a href="#install"><strong>Install</strong></a> &nbsp;·&nbsp;
  <a href="#commands"><strong>Commands</strong></a> &nbsp;·&nbsp;
  <a href="./SKILL.md"><strong>Agent contract</strong></a> &nbsp;·&nbsp;
  <a href="https://drawcms.com/docs/agent-skill"><strong>Documentation</strong></a> &nbsp;·&nbsp;
  <a href="#license"><strong>License</strong></a>
</p>

<p align="center">
  <a href="https://github.com/drawcms/drawcms-skill/stargazers"><img src="https://img.shields.io/github/stars/drawcms/drawcms-skill?style=flat-square&color=0c8c5e&logo=github&label=Stars" alt="GitHub stars" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-0c8c5e?style=flat-square" alt="MIT License" /></a>
  <a href="./SKILL.md"><img src="https://img.shields.io/badge/Agent-Skill-7C3AED?style=flat-square" alt="Agent skill" /></a>
  <a href="#requirements"><img src="https://img.shields.io/badge/node-%E2%89%A518-0891b2?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 18 or newer" /></a>
</p>

<p align="center">
  <a href="https://github.com/drawcms/drawcms"><img src="https://img.shields.io/badge/DrawCMS_editor-0C8C5E?style=for-the-badge" alt="DrawCMS editor repository" /></a>
  <a href="https://drawcms.com/docs/agent-skill"><img src="https://img.shields.io/badge/Docs-181717?style=for-the-badge" alt="Agent skill documentation" /></a>
</p>

<a id="install"></a>

## Install, then ask for a diagram

```bash
npx skills add drawcms/drawcms-skill -g
```

Drop `-g` to install into the current project only. Then send this to your agent:

```text
Diagram this repo's runtime architecture in DrawCMS. Show the core components,
the primary request path, and external dependencies. Animate the request path.
```

The agent analyses the repository, authors the spec, validates it, and syncs it. Follow up with “add the worker queue”, “switch to a sequence diagram of the checkout call”, or “update it — the router moved”.

**Nothing to clone and no `npm install` to *use* the skill.** The installer places the skill folder — `SKILL.md`, references, and the CLI — into your agents. The diagram engine is fetched on first use; see [Fetch the engine](#fetch-the-engine).

## Two modes, one CLI

|                        | DrawCMS Cloud                                | Self-hosted editor                       |
| ---------------------- | -------------------------------------------- | ---------------------------------------- |
| Account / login        | Yes (`drawcms login`, device flow)           | None                                     |
| Repo → project binding | `drawcms init` writes `.drawcms/config.json` | Not applicable                           |
| Delivery               | `drawcms push` (diagram gets a cloud URL)    | `drawcms local` (writes a loadable file) |
| Stays in sync          | Yes — `status` / `diff` / `pull` / `push`    | Re-run `drawcms local` after changes     |
| Share links, autosave  | Yes                                          | No — local only                          |

Authoring and validation (`build`, `edit`, `recommend`, `grammar`) are identical in both modes and need no network.

<a id="commands"></a>

## Commands

```bash
drawcms doctor                      # check Node and the diagram engine
drawcms build <type> <spec.json>    # validate an authored spec headlessly, no network
drawcms local [<type>] <spec|name>  # build for a self-hosted OSS editor; writes a loadable document
drawcms edit <name> <ops.json>      # apply incremental edits, preserving positions
drawcms recommend <entities.json>   # suggest the right element per entity, brand marks included
drawcms grammar [id]                # query the visual grammar: element and motion purpose
drawcms login                       # browser device-flow sign-in; stores a token
drawcms init                        # bind this repo to a DrawCMS project
drawcms pull [name] [--force]       # fetch cloud document(s) into .drawcms/
drawcms push [name] [--force]       # validate and save local document(s) to the cloud
drawcms status                      # local edits, and whether diagrams lag behind HEAD
drawcms diff [name] [--against-cloud]  # code changes since last sync, and a node/edge delta
```

Every command takes `--help` and `--json` for a machine-readable receipt. `<type>` is one of `architecture`, `flowchart`, `sequence`, `data-flow`, or `lifecycle`.

<details>
<summary>How a sync stays safe</summary>

`push` is **fail-closed**. A local document records the cloud version it was pulled from; if the cloud has moved on, the push is refused rather than silently overwriting someone else's edit. `diff --against-cloud` shows the node and connector delta so you can see what would change, and `--force` is the explicit override.

`status` compares each tracked diagram against the last-synced commit, so a diagram that has fallen behind the code it describes is visible without opening it.

</details>

## Requirements

- **Node.js ≥ 18.** No other runtime dependency — the engine bundle carries its own deps inlined.
- **A DrawCMS account** for cloud mode only. The CLI signs you in through the browser; there is no API key. Self-hosted mode (`drawcms local`) needs no account.

<a id="fetch-the-engine"></a>

## Fetch the engine

The CLI needs the DrawCMS diagram engine at `lib/engine.mjs`, a prebuilt bundle published as a release asset on the editor repository. It is **not committed here**: the engine is AGPL-3.0-only and this repository is MIT, so shipping it would change the licence of the whole package.

The agent fetches it automatically on the first `ENGINE_MISSING` error. To do it yourself, run the script from wherever the skill was installed:

```bash
node ~/.claude/skills/drawcms/scripts/fetch-engine.mjs   # checksum-verified download
```

Until it is present, engine-dependent commands (`build`, `push`, `local`, `edit`, `grammar`) return a clear `ENGINE_MISSING` error naming the fix. `login`, `init`, `pull`, `status`, and `diff` work without it.

<details>
<summary>Working from a clone, and rebuilding the engine from source</summary>

```bash
npm install
npm run fetch-engine      # downloads lib/engine.mjs from the pinned release, checksum-verified
npm run check:engine      # CI: fails if lib/engine.mjs is missing or does not match the pin
drawcms doctor            # confirms Node + engine
```

Maintainers who would rather build the engine than download it can use `npm run build:engine`, which needs a packed `@drawcms/editor` release:

```bash
DRAWCMS_EDITOR_TGZ=/path/to/drawcms-editor-x.y.z.tgz npm run build:engine
```

Then bump the pinned checksum in `scripts/fetch-engine.mjs`.

</details>

## Installation options

<details>
<summary>Manual install, symlinking one canonical copy, PATH, and uninstall</summary>

The skill is one self-contained folder. Copy it — or a packaged zip from `npm run package` — into the agent's skills directory. Paths were verified at time of writing; check each agent's docs if a version differs.

| Agent | Install location |
| --- | --- |
| Claude Code | `~/.claude/skills/drawcms/` (or `.claude/skills/drawcms/` per project) |
| Codex CLI | `~/.agents/skills/drawcms/` or `~/.codex/skills/drawcms/` |
| OpenCode | `~/.config/opencode/skills/drawcms/`, `.opencode/skills/drawcms/`, or `.agents/skills/drawcms/` |
| OpenClaw | `~/.openclaw/workspace/skills/drawcms/` |
| Hermes | `~/.hermes/skills/drawcms/` |

### One canonical copy, symlinked everywhere

`~/.agents/skills/` is the shared convention several CLI agents read, so install there once and point the others at it. Symlinking rather than copying means edits take effect immediately — the right choice while developing.

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

To distribute to other machines, ship a copy instead:

```bash
npm run package                       # dist/drawcms/ + dist/drawcms-skill.zip
cp -R dist/drawcms ~/.claude/skills/drawcms
```

### Put `drawcms` on PATH

Installing a skill folder does not put its binary on `PATH`. `SKILL.md` teaches agents to fall back to `node <skill-folder>/bin/drawcms.mjs`, so the skill works either way — the short form is just nicer:

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

</details>

## Configuration

| Scope | Path | Holds |
| --- | --- | --- |
| Global | `~/.drawcms/config.json` (mode 0600) | Auth token and default origin |
| Per repo | `<repo>/.drawcms/config.json` | Workspace and project binding, plus each diagram's id, version, and last-synced commit |
| Per repo | `<repo>/.drawcms/<name>.json` | The local diagram documents |

Point at a non-default server with `--origin <url>` or `DRAWCMS_ORIGIN`.

<details>
<summary>Security model</summary>

- The token file is written `0600`, and a token is only ever sent to the origin it was issued for — a redirect or config pointing somewhere else does not carry it.
- Origins must be `https://`, with `http://` allowed only for loopback during local development. Insecure or cross-origin attempts fail with `INSECURE_ORIGIN` / `CROSS_ORIGIN_TOKEN` rather than leaking the credential.
- Responses are size-capped, and only safe URL schemes are opened in a browser.

</details>

## Layout

```
SKILL.md                 # the agent contract (frontmatter + instructions)
bin/drawcms.mjs          # CLI entrypoint (git-like commands)
lib/                     # command implementations + the fetched engine
examples/                # one authored spec per diagram type, plus an animated one
references/              # analysis method, motion, and vocabulary (read on demand)
scripts/fetch-engine.mjs # checksum-verified engine download
skill-release.json       # skill id + version metadata
test/                    # 123 tests, run with `npm test`
```

## Development

```bash
npm run ci            # check:engine → lint:skill → test
npm test              # 123 tests via node --test
npm run lint:skill    # validates SKILL.md frontmatter and structure
npm run package       # dist/drawcms/ + dist/drawcms-skill.zip
```

Reference material for agents lives in [`references/analysis.md`](./references/analysis.md), [`references/motion.md`](./references/motion.md), and [`references/vocabulary.md`](./references/vocabulary.md). Example specs are in [`examples/`](./examples/). End-to-end and local testing notes are in [`docs/E2E.md`](./docs/E2E.md) and [`docs/LOCAL-TESTING.md`](./docs/LOCAL-TESTING.md).

## License

MIT — see [`LICENSE`](./LICENSE). This covers the skill instructions and the `drawcms` CLI wrapper in this repository.

The diagram engine the CLI loads at `lib/engine.mjs` is derived from [`@drawcms/editor`](https://github.com/drawcms/drawcms), which is **AGPL-3.0-only**. It is fetched or built onto your machine and is **not** committed or redistributed by this MIT repository — which is why fetching it is a setup step rather than a shipped artifact. If you redistribute a build that includes the engine, the AGPL-3.0 terms apply to that combined distribution.
