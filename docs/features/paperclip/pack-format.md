# Pack format v1

> **Frozen 2026-10-02** with the owner's sign-off (Work Platform step 3;
> [ADR 0021](../../adr/0021-pack-format-v1-file-shapes.md)). The pack format is a public contract: change it
> only by a new ADR. The layout and the `pack.json` field list come from
> [section F](minimum-sellable-product.md#f-minimum-pack-format-v1) and
> [ADR 0018](../../adr/0018-managed-solution-packs-v1.md); this page only adds the exact file shapes
> and the rules `pack validate` enforces.

A pack is a directory of declarative files. It holds no executable code, no secrets and no customer
identifiers. Every JSON and YAML file is strict: an unknown key is an error.

## Files

| File | Required | What it holds |
|---|---|---|
| `pack.json` | yes | identity, requirements, resource list |
| `paperclip/bundle/` | yes | Paperclip company-portability bundle (not parsed in v1; scanned only) |
| `paperclip/routines/*.json` | no | native Paperclip create-routine bodies |
| `paperclip/pipelines/*.json` | yes, one or more | native Paperclip create-pipeline bodies, plus an optional `transitions` list (`fromStageKey`, `toStageKey`, `label`) |
| `agents/*.yaml` | yes, one per role | the canonical agent format |
| `skills/*.md` | no | instruction text an agent names |
| `config/schema.json` | yes | the settings a deployment fills in |
| `connectors.json` | yes | capabilities, scopes, tool aliases |
| `policies.json` | yes | tool risk, approval gates, decision-class bindings |
| `ui.json` | yes | key fields the case screen shows, per pipeline |
| `studio/layout.json` | no | reserved for the Workflow Studio; the installer ignores it |
| `tests/`, `migrations/`, `docs/` | no | scanned for secrets and identifiers only |

## `pack.json`

```json
{
  "packFormat": 1,
  "id": "example-referrals",
  "name": "Example Referrals",
  "version": "1.0.0",
  "description": "Routes inbound referrals to review.",
  "industry": "healthcare",
  "compatibility": {
    "netzer": { "min": "1.1.0" },
    "paperclip": { "min": "v2026.916.1", "tested": ["v2026.916.1"] }
  },
  "resources": {
    "bundle": "paperclip/bundle",
    "pipelines": ["paperclip/pipelines/referral.json"],
    "routines": [
      { "path": "paperclip/routines/intake.json", "kind": "ingest", "pipeline": "referral" },
      { "path": "paperclip/routines/sla-check.json", "kind": "timer", "pipeline": "referral" }
    ],
    "skills": ["skills/intake.md"],
    "connectors": "connectors.json",
    "policies": "policies.json",
    "ui": "ui.json",
    "studioLayout": "studio/layout.json"
  },
  "agents": [
    { "role": "intake", "definition": "agents/intake.yaml", "mappable": true }
  ],
  "requires": {
    "connectors": ["ehr.client"],
    "permissions": { "capabilities": ["work:read"], "tools": { "intake": ["ehr.client.search"] } },
    "config": "config/schema.json",
    "secrets": [{ "name": "EHR_API_KEY", "store": "secrets-manager" }]
  },
  "decisionClasses": [{ "id": "clinical_disposition", "impact": "high", "default": "human_required" }],
  "dataClasses": ["PHI"],
  "supportOwner": "netzer-support",
  "checksums": "checksums.json"
}
```

- `packFormat` is the only field added to the approved list. It lets a later reader refuse a format it does not know.
- `id` and each `role`: lowercase letters, digits and dashes. `version`: semver.
- `resources.routines[].kind` is `ingest` or `timer`. `resources.studioLayout` and `checksums` are optional.
- `requires.secrets[].store` is `secrets-manager` or `agentcore-identity`. Names only, never values.
- `decisionClasses[].impact` is `high` or `standard`; `default` is `human_required` or `automated_allowed`.

## `agents/*.yaml` (the one agent format)

```yaml
id: intake
name: Intake Agent
description: Reads a new referral and fills the case fields.
model: us.anthropic.claude-sonnet-4-6
knowledgeScope: default
persona: |
  You read inbound referrals...
tools:
  - ehr.client.search
skills:
  - skills/intake.md
```

`id`, `name`, `description`, `model` and `persona` are required. `tools`, `skills` and `knowledgeScope`
are optional in the format; **inside a pack `tools` is required** (an empty list is allowed). The built-in agent
templates use the same schema. Anchors, aliases, custom tags and multi-document files are rejected.

## `config/schema.json`

```json
{
  "type": "object",
  "properties": {
    "escalation_hours": { "type": "number", "default": 24, "title": "Escalate after (hours)", "customerEditable": true },
    "clinical_review_required": { "type": "boolean", "default": true },
    "site": { "type": "enum", "enum": ["north", "south"], "default": "north" },
    "ehr_api_key": { "type": "secretRef", "secret": "EHR_API_KEY" },
    "ehr": { "type": "connectorRef", "capability": "ehr.client" }
  },
  "required": ["ehr_api_key", "ehr"]
}
```

Types: `string`, `number`, `boolean`, `enum`, `secretRef`, `connectorRef`. Per field: `title`, `description`,
`default`, `customerEditable` (default `false`) and `controlsApproval` (default `false`). A `default` must match the
field's type. `secretRef` and `connectorRef` fields take no default and can never be `customerEditable`.
`required` may only name fields that exist.

## `connectors.json`

```json
{
  "capabilities": {
    "ehr.client": {
      "description": "Look up and update clients in the EHR.",
      "mandatory": true,
      "scopes": ["client.read"],
      "aliases": { "ehr.client.search": { "defaultTool": "searchClient" } }
    }
  }
}
```

The real Gateway target and any alias override are customer config, not pack content.

## `policies.json`

```json
{
  "toolRisk": { "ehr.client.search": "low" },
  "approvalGates": [
    { "pipeline": "referral", "stage": "clinical-review", "decisionClass": "clinical_disposition" }
  ]
}
```

`toolRisk` values: `low`, `medium`, `high`. Decision classes are declared once, in `pack.json`; `policies.json`
binds them to stages.

## `ui.json`

```json
{ "pipelines": { "referral": { "keyFields": [{ "field": "client_name", "label": "Client" }] } } }
```

## `studio/layout.json`

Any JSON object. The installer never reads it. It is still scanned for secrets and customer identifiers.

## Placeholders

`${config.<field>}`, `${agent:<role>}` and `${routine:<key>}` (the routine file's base name) may appear in any
string of a routine or pipeline body. Nothing else with the `${...}` shape is allowed there.

## What `pack validate` checks

Run `npm run pack -- validate <dir> [--denylist <file>]`. Exit 0 clean, 1 findings (one per line as
`<code> <file>[:<pointer>] <message>`), 2 usage error. A finding never repeats the secret or identifier it found.
A file that fails `PV-SCHEMA` is not checked further, so one mistake gives one kind of finding.

| Code | Rule |
|---|---|
| `PV-SCHEMA` | every file above parses and matches its shape; every path in `pack.json` exists and stays inside the pack |
| `PV-REF` | cross-references resolve: a role ↔ its agent file's `id`; agent skills ↔ `resources.skills`; agent tools and `toolRisk` tools ↔ connector aliases or that pack's `requires.permissions.tools`; `requires.permissions.tools` roles ↔ declared roles; `requires.connectors` ↔ `connectors.json`; `secretRef`/`connectorRef` ↔ declared secrets and capabilities; `approvalGates` ↔ pipeline and stage keys; `ui.json` ↔ pipeline keys; a routine's `pipeline` ↔ pipeline keys; transitions ↔ stage keys |
| `PV-PLACEHOLDER` | every placeholder resolves to a config field, a role or a routine |
| `PV-SECRET` | no secret literal in any file of the pack directory (the repository's secret scanner, `scripts/ci/secret-scan.mjs`) |
| `PV-ENQUEUE` | every `ingest` routine has `concurrencyPolicy: "always_enqueue"`; every pipeline has at least one `ingest` routine |
| `PV-IDENTIFIER` | no customer identifiers in any file of the pack directory: 12-digit AWS account ids, ARNs carrying one, and email addresses and URLs outside the reserved example names (`example.com`, `example.org`, `example.net`, `*.example`, `*.test`, `*.invalid`, `localhost`), plus any `--denylist` entry (case-insensitive) |
| `PV-GATE` | a gate field is never `customerEditable`. A config field is a gate field when a `${config.<field>}` placeholder names it inside a pipeline stage that `policies.json` lists under `approvalGates`, or when it carries `controlsApproval: true`. `secretRef` and `connectorRef` fields are never `customerEditable` either |
| `PV-DECISION` | a `high` impact class defaults to `human_required`; every class used by a gate is declared, and every declared class is used |

## Not in v1 of the validator

Validating customer config values (`pack validate --config`), checking pipeline and routine bodies against
Paperclip's full schema, and checksum verification belong to step 8 (trusted install).
