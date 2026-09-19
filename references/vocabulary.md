# DrawCMS authoring vocabulary

The exact element and edge types the DrawCMS engine accepts, by diagram type.
Validation rejects anything else with `invalid_enum_value` naming the received
value, so author from this list. Run `drawcms build <type> <spec>.json --json`
to confirm — the receipt is authoritative if this doc ever drifts from the
engine.

Node shape: `{ "id": "unique-id", "label": "Human text", "type": "<type>", "position"?: { "x": n, "y": n } }`
Edge shape: `{ "source": "id", "target": "id", "label"?: "text", "type"?: "<edge-type>" }`

Omit `position` for automatic layout (preferred). Omit edge `type` for the
default connector of the diagram type.

## architecture

### Choosing an element: name the technology, then pick the closest mark

The most important authoring decision for an architecture diagram is element
type. Two rules, in order:

1. **If a node names a specific product the code actually uses, use that
   product's brand element** (below). A Redis cache should be `infra-redis`
   (recognizable Redis logo), not a generic `arch-database` box. This is what
   makes the diagram read at a glance.
2. **Otherwise use the generic category.** An unnamed "cache" or "primary
   datastore" is correctly `arch-database` — the generic category is the right
   answer, not a fallback.

Truthfulness floor: a **correct generic box beats a wrong brand icon.** Only
reach for a specific mark when the code names that exact product — in a
manifest (`package.json`, `requirements.txt`, `go.mod`), a container image
(`docker-compose.yml`, `Dockerfile`), an SDK import, or an IaC resource
(`*.tf`). Never infer a brand from a vague role. A brand icon asserts a fact
about the system; do not assert one the repo does not support.

Brand elements render as fixed-size logo tiles without the category accent
color; generic categories render as styled, variable-width shapes. Choose on
fidelity to the code, not aesthetics.

### Generic category types (the default)

- `arch-frontend` — clients, browsers, mobile/web apps
- `arch-backend` — services, APIs, workers
- `arch-database` — databases, caches, any datastore (unnamed)
- `arch-cloud` — managed cloud services (unnamed)
- `arch-security` — auth, gateways, firewalls, trust controls
- `arch-messagebus` — queues, brokers, event buses (unnamed)
- `arch-external` — third-party systems outside your control (Stripe, Twilio,
  a partner API — anything with no first-party brand element below)

Boundaries (optional grouping frames): `boundary-region`,
`boundary-security-group`, `boundary-trust`, `boundary-deployment`,
`boundary-data`. These render a large titled frame but do **not** structurally
contain other nodes — the spec has no parent/child field. A frame with nothing
positioned inside it draws as an empty box (`CONTAINER_USED_AS_STEP` warning).
Prefer conveying grouping through layout (tier order, dependency direction);
reach for a frame only when a trust/deployment region is the diagram's point,
and then give its members explicit `position` coordinates that fall within the
frame. See the grouping rule in SKILL.md.

### Infrastructure brand elements (self-hosted / open source)

| Product named in the code | element |
| --- | --- |
| Redis | `infra-redis` |
| PostgreSQL / Postgres | `infra-postgresql` |
| MongoDB | `infra-mongodb` |
| Elasticsearch / OpenSearch | `infra-elasticsearch` |
| RabbitMQ | `infra-rabbitmq` |
| Kubernetes / k8s | `infra-kubernetes` |
| Docker | `infra-docker` |
| Terraform | `infra-terraform` |
| Nginx | `infra-nginx` |
| Grafana | `infra-grafana` |

### AWS brand elements

`aws-ec2`, `aws-s3`, `aws-lambda`, `aws-rds`, `aws-dynamodb`, `aws-vpc`,
`aws-cloudfront`, `aws-route53`, `aws-ecs`, `aws-eks`, `aws-sns`, `aws-sqs`,
`aws-api-gateway`, `aws-iam`, `aws-cloudwatch`, `aws-elb`,
`aws-elastic-beanstalk`, `aws-fargate`, `aws-redshift`, `aws-aurora`.

### Google Cloud brand elements

`gcp-compute-engine`, `gcp-cloud-storage`, `gcp-cloud-functions`,
`gcp-cloud-sql`, `gcp-bigquery`, `gcp-gke`, `gcp-pub-sub`, `gcp-cloud-run`,
`gcp-cloud-cdn`, `gcp-iam`, `gcp-cloud-endpoints`, `gcp-firestore`,
`gcp-spanner`, `gcp-memorystore`, `gcp-cloud-armor`.

### Azure brand elements

`azure-vm`, `azure-blob-storage`, `azure-functions`, `azure-sql-db`,
`azure-cosmos-db`, `azure-aks`, `azure-service-bus`, `azure-app-service`,
`azure-cdn`, `azure-active-directory`, `azure-api-management`,
`azure-key-vault`, `azure-event-hub`, `azure-front-door`,
`azure-container-instances`.

Pick the cloud logo only when the component's own name or manifest names that
exact product — do not label a store `aws-s3` when the code uses Google Cloud
Storage. When you are unsure which specific product a node is, `drawcms
recommend` maps entity labels to the best **infra-*** element (it covers the 10
infrastructure brands above, not the cloud logos, and matches on the label's
words with no repo awareness — treat its output as a suggestion to confirm
against the code, never as proof).

Edges: default directed connector; add `label` for the protocol/action
(`HTTPS`, `SQL`, `gRPC`, `publish`).

## flowchart

Node types: `terminator` (start/end), `process` (a step), `decision` (a
branch — its `label` should be a question), `document`, `data`, `database`,
`predefined`, `manual-input`, `delay`, `display`.

Edges: default control-flow connector. Label the branches out of a `decision`
(`yes`/`no`, `approved`/`rejected`).

## sequence

Node types: `sequence-participant` (a lifeline; use for services, actors, and
systems) and `sequence-actor` (a human actor).

Edge types (chronological order matters — messages attach to lifeline rows in
array order):

- `sequence-message` — a synchronous call
- `sequence-message-async` — an asynchronous message
- `sequence-message-return` — a return/response (dashed)
- `sequence-message-self` — a self-call (consumes two rows)

Limit: 12 message rows per diagram; exceeding it is a retryable validation
error — split into smaller sequences.

## data-flow

Node types: `data-source` (origin), `data-transform` (processing/ETL step),
`data-store` (warehouse/db at rest), `data-stream` (a stream/topic),
`data-sink` (consumer/destination), `data-protected` (PII/regulated),
`data-stage` (a grouping stage).

Edges: default flow connector; label with what moves (`raw JSON`, `typed rows`,
`aggregates`).

## lifecycle

Node types: `lifecycle-start`, `lifecycle-active`, `lifecycle-waiting`,
`lifecycle-decision`, `lifecycle-success`, `lifecycle-failure`,
`lifecycle-neutral`, `lifecycle-external`.

Edges: default transition connector; label with the event that causes the
transition (`dequeue`, `error`, `backoff elapsed`, `max attempts`). A
recoverable failure transitions back to an active state.

## Motion

Animated by default: every connector gets a continuously-looping preset
(sequence → `Sequence Flow`, other edges → `Data Flow`) on every diagram type,
and `beats`/`story` add the walkthrough steps. Pass `--static` for a still
diagram. Set `motion: { preset, loop?, speed? }` on a node or edge to control it
explicitly (always kept, including `loop: false`; stripped only under `--static`).

- Node motion presets: `Bounce`, `Spin`, `Pulse Node`, `Shake`.
- Edge motion presets: `Pulse`, `Data Flow`, `Sequence Flow`,
  `Sequential Glow`, `Fade Path`, `Orbit`.

Applied motion loops continuously by default (`loop: false` plays once); the
human drives playback in the editor. Reduced-motion preferences are respected
automatically. For the full contract — the `motion` field shape, `beats`, and
explicit scene stories (walkthrough steps) — see `references/motion.md`.
