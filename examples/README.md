# Examples

Copy-paste-ready sample artifacts for the three things operators configure
most often: a per-agent system prompt, an agent registration, and an MCP
tool-server entry. Each shape below is validated against the real parser in
the codebase (named per section) — if you change a parser, update the example.

Replace every `<placeholder>` before running a command.

| Artifact | Where it lives in a deployed install |
| --- | --- |
| `agents/research-bot/CLAUDE.md` | S3 config bucket, key `agents/<agent-id>/CLAUDE.md` |
| `agents/research-bot/agent.yaml` | S3 config bucket, key `agents/<agent-id>/agent.yaml` |
| `mcp/servers.json` | ONE runtime-config row: DDB table `claudeclaw-runtime-config`, `PK=CONFIG#mcp`, `SK=servers`, the JSON array as a string in the `value` attribute |

---

## 1. Agent system prompt — `agents/research-bot/CLAUDE.md`

Per-agent system prompts live in the S3 **config bucket** (the
`CONFIG_BUCKET` task env var / the `claudeclaw[-suffix]-config-...` bucket),
NOT in this repo and NOT in DynamoDB. The orchestrator caches them for
**5 minutes** (`src/config/agent-loader.ts`), so an edit is just an S3
upload — no deploy, picked up within 5 minutes.

```bash
aws s3 cp examples/agents/research-bot/CLAUDE.md \
  s3://<config-bucket>/agents/research-bot/CLAUDE.md \
  --content-type "text/markdown; charset=utf-8"
```

The easier path for day-to-day edits is the dashboard: Agents tab → select
the agent → edit the file (`PUT /api/agents/:id/file`), which also records a
revision in the file-history table and invalidates the cache immediately.

Validated by: `fetchFromS3()` in `src/lib/config/agent-loader.ts` (any
non-empty markdown body is accepted; the whole file becomes the system
prompt verbatim).

## 2. Agent registration — `agents/research-bot/agent.yaml` + the DDB row

An agent is **three artifacts**, created together by
`createAgentFull()` in `src/lib/agents/agent-manager.ts`:

1. a row in the **agents table** (DDB),
2. `agents/<id>/CLAUDE.md` in the config bucket (section 1),
3. `agents/<id>/agent.yaml` in the config bucket.

The recommended way to create one is the dashboard (Agents tab → Create,
i.e. `POST /api/agents/create`), which writes all three consistently. The
commands below replicate what it does, for scripted/bootstrap use.

### 2a. agent.yaml (S3)

`examples/agents/research-bot/agent.yaml` matches exactly what
`agent-manager.ts` writes: a **flat** `key: value` document with four keys
(`name`, `description`, `model`, `knowledgeScope`). The runtime parser
(`readYamlScalar()` in `src/lib/config/agent-loader.ts`) is a line scanner —
no nesting, no lists, no multi-line values. At runtime only
`knowledgeScope` is read from this file (it selects the vector corpus the
agent searches, in addition to the always-shared `shared` scope); name,
description, and model are authoritative in the DDB row.

```bash
aws s3 cp examples/agents/research-bot/agent.yaml \
  s3://<config-bucket>/agents/research-bot/agent.yaml \
  --content-type "text/yaml; charset=utf-8"
```

### 2b. The agents-table row (DDB)

Shape: `AgentMetadata` (`src/lib/agents/types.ts`) stored with
`PK=AGENT#<agentId>`, `SK=META` (`src/lib/state/agents-repo.ts`). Agent ids
must match `^[a-z][a-z0-9_-]{0,29}$`. Surface credentials
(`telegramBotToken`, `slackBotToken`, ...) are added later by the
per-agent Connections tab — don't seed them by hand.

```bash
aws dynamodb put-item \
  --table-name <claudeclaw[-suffix]-agents> \
  --condition-expression "attribute_not_exists(PK)" \
  --item '{
    "PK":           {"S": "AGENT#research-bot"},
    "SK":           {"S": "META"},
    "agentId":      {"S": "research-bot"},
    "displayName":  {"S": "Research Bot"},
    "description":  {"S": "Deep-research agent. Investigates questions thoroughly, cross-checks sources, and synthesizes findings with citations."},
    "model":        {"S": "<bedrock-model-or-inference-profile-id>"},
    "template":     {"S": "research"},
    "status":       {"S": "inactive"},
    "knowledgeScope": {"S": "research"},
    "createdAt":    {"S": "<iso-timestamp>"},
    "updatedAt":    {"S": "<iso-timestamp>"},
    "createdBy":    {"S": "<your-name>"}
  }'
```

Notes:
- `status` lifecycle is `creating → inactive → active` (`AgentStatus` in
  `src/lib/agents/types.ts`); activate via the dashboard
  (`POST /api/agents/:id/activate`).
- `model` defaults to the platform's `BEDROCK_DEFAULT_MODEL` when created
  through the API; a hand-seeded row must set it explicitly. The dashboard
  can change it later (the DDB row's model wins over agent.yaml at runtime).
- `template` is informational here (`blank`, `comms`, `content`, `ops`,
  `research` — `src/lib/agents/templates.ts`).

Validated by: `src/lib/state/agents-repo.ts` (row shape) and
`src/lib/agents/agent-manager.ts` (id rules, creation side-effects).

## 3. MCP server registry — `mcp/servers.json`

The whole MCP registry is **one JSON array stored as a single
runtime-config value** (category `mcp`, key `servers`) — not one row per
server, not a file, not CDK. Edits propagate to every task within ~30
seconds (runtime-config cache poll + SNS invalidation); no redeploy.

Schema per entry, enforced by `sanitize()` in
`src/lib/mcp/servers-repo.ts` (invalid entries are silently dropped):

| Field | Rules |
| --- | --- |
| `id` | required, `^[a-z0-9][a-z0-9_-]{0,31}$`; namespaces tool names as `mcp__<id>__<tool>` |
| `name` | optional display name; defaults to `id` |
| `url` | required, must start `https://` (Streamable-HTTP MCP endpoint) |
| `auth` | required: `iam` (SigV4 with the task role — AgentCore gateways), `bearer`, or `none` |
| `bearerToken` | only kept when `auth` is `bearer` |
| `enabled` | defaults to `true`; disabled servers contribute no tools |
| `agents` | agent-id allowlist; `[]` (empty) = every agent gets the server's tools |

Note there is **no per-tool allowlist field** — allowlisting is per agent
via `agents`; every tool the server reports rides along, and all MCP tools
honor the `tool_use` kill switch like built-ins.

### How the entry lands in runtime-config

Preferred: the dashboard's MCP/Integrations UI, which calls
`saveMcpServers()` (`src/lib/mcp/servers-repo.ts`) — it validates,
rejects duplicate ids, and publishes the cache invalidation.

Scripted alternative (`aws dynamodb put-item`): the registry is one item in
the runtime-config table with the array JSON-encoded into the `value`
string attribute (row shape: `src/lib/state/runtime-config-repo.ts`).

```bash
SERVERS_JSON=$(cat examples/mcp/servers.json | python3 -c 'import json,sys; print(json.dumps(json.dumps(json.load(sys.stdin))))')

aws dynamodb put-item \
  --table-name <claudeclaw[-suffix]-runtime-config> \
  --item "{
    \"PK\":        {\"S\": \"CONFIG#mcp\"},
    \"SK\":        {\"S\": \"servers\"},
    \"value\":     {\"S\": $SERVERS_JSON},
    \"updatedAt\": {\"S\": \"<iso-timestamp>\"},
    \"updatedBy\": {\"S\": \"<your-name>\"}
  }"
```

(The `python3` line JSON-encodes the array into a string, then escapes that
string for embedding in the `--item` JSON. A direct DDB write bypasses the
SNS invalidation publish, so allow up to ~30 s for the cache poll to pick
it up.)

The AgentCore **gateway itself** (the `iam`-auth endpoint in the example) is
created out-of-band via CLI, not CDK — see `docs/mcp/README.md`.
