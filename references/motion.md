# Motion and stories

Diagrams ship with a **scene story by default** — the ordered walkthrough steps
a reader clicks through — and are **animated by default**: every connector gets
a continuously-looping motion preset so the diagram plays as soon as it is
created, on every diagram type. So author `beats` (or a `story`) on every
diagram; the walkthrough comes for free. Ask for `--static` only when the user
wants a still diagram.

`build` gives each edge a looping preset — `Sequence Flow` for sequence
messages, `Data Flow` for everything else — unless you set `motion` on that edge
explicitly (that always wins, including an explicit `loop: false`). Pass
`--static` to strip all element motion (the story stays) for a
still diagram. Playback is human-driven in the editor — the skill
authors the story, the viewer presses play. `prefers-reduced-motion` is
respected automatically.

## Two independent layers

1. **Motion presets** — per-element animation (a node pulses, a connector
   flows). Ambient; plays on a loop unless told otherwise.
2. **A scene story** — an ordered walkthrough (step 1 highlights these
   elements, step 2 those). This is the "steps" a presenter clicks through.

Use either or both. A story does not require presets, and presets do not
require a story.

## Motion presets

Set `motion` on a node or edge object in the spec:

```json
{ "id": "api", "label": "API", "type": "arch-backend",
  "motion": { "preset": "Pulse Node" } }

{ "source": "api", "target": "db", "label": "SQL",
  "motion": { "preset": "Data Flow", "loop": false, "speed": 1.5 } }
```

`motion` fields:

- `preset` (required) — one of the presets below. Node presets go on nodes,
  edge presets on edges; mixing them is rejected.
- `loop` (optional, default `true`) — `false` plays the animation once.
- `speed` (optional, default `1`) — multiplier; `1.5` is faster, `0.5` slower.

Node presets: `Bounce`, `Spin`, `Pulse Node`, `Shake`.
Edge presets: `Pulse`, `Data Flow`, `Sequence Flow`, `Sequential Glow`,
`Fade Path`, `Orbit`.

Guidance: animate only the element or relationship a step is about — a whole
diagram pulsing at once reads as noise. `Data Flow` / `Sequence Flow` on
connectors show direction of movement; `Pulse Node` marks an active component.

## Scene story — the walkthrough steps

Two ways to author the story. Prefer **beats** unless you need exact control.

### Beats (recommended)

`beats` is the intent layer: an ordered list of narrative moments. DrawCMS turns
them into one scene with generated ids and, when a beat has a `kind`, derives a
sensible motion preset for the elements it names.

```json
{
  "diagramType": "architecture",
  "nodes": [ ... ],
  "edges": [ ... ],
  "beats": [
    { "title": "Browser calls the API", "nodeIds": ["browser", "api"], "kind": "request" },
    { "title": "API reads the cache", "edgeIds": ["api-redis"], "kind": "data-flow" },
    { "title": "Cache miss falls through to Postgres", "nodeIds": ["db"], "kind": "data-flow" }
  ]
}
```

Each beat: `title` (required), optional `description`, the `nodeIds` and/or
`edgeIds` it concerns, and an optional semantic `kind` that resolves to motion:
`request`, `response`, `async`, `self-call`, `data-flow`, `handshake`,
`dependency`, `state-transition`, `error`, `cycle`. An explicit `motion` set on
a node/edge overrides what a beat's `kind` would derive for it.

Reference an **edge by `"source>target"`** (or `"source>target#N"` for the Nth
message between the same pair). The skill resolves that to the real edge id, so
you never need the engine's generated id. (`nodeIds` are matched directly.)

**Sequence diagrams: one message per beat.** A sequence walkthrough must advance
one message at a time — target the **edge** for each step
(`"edgeIds": ["user>client"]`), one beat per message in chronological order. Do
**not** target the participant nodes: a node-targeted step activates every
message touching those participants at once, so multiple arrows play in parallel
instead of stepping through the interaction.

### Explicit story (full control)

Use when you need exact scenes, per-step pacing, or multiple scenes. Every scene
and step **requires an `id`** (beats generate these for you; the explicit form
does not):

```json
{
  "diagramType": "sequence",
  "nodes": [ ... ],
  "edges": [ ... ],
  "story": {
    "scenes": [
      {
        "id": "login",
        "title": "Login flow",
        "steps": [
          { "id": "s1", "title": "User submits credentials",
            "targets": [ { "targetId": "user", "targetKind": "node" } ], "durationMs": 1200 },
          { "id": "s2", "title": "API verifies and responds",
            "targets": [ { "targetId": "api", "targetKind": "node" } ] }
        ]
      }
    ]
  }
}
```

Step fields: `id`, `title`, `targets` (each `{ targetId, targetKind }` where
`targetKind` is `node` or `edge`, and `targetId` must exist in the diagram), and
optional `durationMs` pacing. If both `beats` and `story` are present, `story`
wins.

## Verifying

`drawcms build <type> <spec>.json --json` compiles the story into
`document.motion.story.scenes[]`. An **invalid motion preset** (or a node preset
on an edge) fails the build outright. A **target id that is not a node or edge
in the diagram** is dropped by the engine — `build` catches this and reports it
as a `STORY_TARGET_NOT_FOUND` warning naming the id, so a typo produces a
visible warning instead of a step that silently highlights nothing. Resolve
warnings before `push`: a step pointing at a missing element is almost always a
mistake in the id.
