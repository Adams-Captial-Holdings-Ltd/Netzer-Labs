# Diagrams

Two sets live here:

1. **Tier-1 Mermaid suite** (maintained), text-source diagrams that render natively on GitHub and diff in PRs. These are the source of truth for architecture and lifecycle docs; each is mapped to the code it depicts in [`../diagrams.map`](../diagrams.map) so CI can flag drift (IaC readiness plan, item 32).
2. **Legacy Excalidraw / PNG assets**, the earlier hand-built walkthrough canvas and rendered PNG sets. Kept as-is for reference and reuse; they are NOT maintained against code changes.

## Tier-1 Mermaid suite (maintained)

Split by concern, never one 15-stack hairball. Each file opens with a 3-sentence plain-English summary, then the diagram, then a legend. Conservative Mermaid subset only (`flowchart TD/LR` + `sequenceDiagram`, no experimental syntax) so GitHub's renderer version churn can't break them.

| Diagram | Concern |
|---|---|
| [architecture-compute.md](architecture-compute.md) | User → surfaces → edge → ALB → Fargate → Bedrock; infra-only/internal-ALB variant |
| [architecture-data.md](architecture-data.md) | S3 buckets, DDB tables grouped by purpose, KMS keys, secrets |
| [architecture-messaging.md](architecture-messaging.md) | SQS queues, SNS topics, EventBridge Scheduler group + runtime schedules, consolidation spawner |
| [architecture-security.md](architecture-security.md) | Trust boundaries: IAM-auth'd vs secret-auth'd vs external; kill-switch locations |
| [request-lifecycle.md](request-lifecycle.md) | One Telegram message end-to-end, webhook → guardrailed Converse → tool loop → reply + audit |
| [deploy-pipeline.md](deploy-pipeline.md) | Phased deploy: preflight → bootstrap-state + lock → image gate → stacks → secrets → seed → validate → manifest |
| [rollback-classes.md](rollback-classes.md) | Image / infra / config / data rollback decision tree with preconditions, ending in verify |
| [teardown-decision-tree.md](teardown-decision-tree.md) | Inventory → classify → typed confirm → ordered destruction → KMS gate → WORM residuals → break-glass |

Ownership: `docs/diagrams.map` maps each diagram to the source paths it depicts (owner `@emmanuelmadams4-lgtm`). A CI gate will flag PRs that touch mapped components without touching their diagram.

## Legacy assets (not maintained)

The subfolders `architecture/`, `system-flow/`, and `os-vs-enterprise/` hold rendered PNG sets from the May 2026 visual pass, and the two `.excalidraw` files below are the editable canvases. They predate the Mermaid suite and are not updated when code changes; treat the Mermaid suite as authoritative where they disagree.

## system-walkthrough.excalidraw

A story-style end-to-end of how the system works when someone says hi. Each microservice is personified with a friendly name + a one-line role.

### How to open

Drag the file onto [excalidraw.com](https://excalidraw.com/), or open it in the Excalidraw VS Code extension / desktop app.

### How to regenerate

```bash
node docs/diagrams/build-walkthrough.mjs
```

The script is the source of truth — edit it (add a character, change colours, rewire an arrow) and re-run.

### Cast

| Character | Role | Real service |
|---|---|---|
| **Sally 📱** | Slack DMs / channel mentions | `src/adapters/slack/` |
| **Tom 💬** | Telegram (voice in/out) | `src/adapters/telegram/` |
| **Mira 🖥️** | Mission Control SPA | `/dashboard` |
| **Eddie 🌐** | Global edge | CloudFront (T3) |
| **Wally 🛡️** | OWASP + rate-limit | WAFv2 regional |
| **Bob 🚪** | "origin only" gate | ALB listener rule (B1) |
| **Carla 🎩** | The conductor | Fargate orchestrator |
| **Dex 🕵️** | Note-taker | X-Ray daemon sidecar (D1) |
| **Saanvi 🧙** | The wise advisor | Bedrock Claude (Sonnet/Opus/Haiku via inference profile) |
| **Phil 🧹** | PII + prompt-injection cleaner | Bedrock Guardrail |
| **Memo 📓** | Sessions | `claudeclaw-sessions` DDB |
| **Rosa 🌱** | Memories | `claudeclaw-memories` DDB |
| **Cal 📅** | Scheduled tasks | `claudeclaw-scheduled-tasks` DDB |
| **Tess 📝** | Audit log (append-only) | `claudeclaw-audit-log` DDB |
| **Ben 🛑** | 40 kill switches | `claudeclaw-kill-switches` DDB |
| **Ada 🎨** | Image generation | Nova Canvas |
| **Stella 📄** | PDF / DOCX / XLSX | `generate_document` tool (C1) |
| **Scarlet 🔍** | Live web search | Tavily / Brave / Exa adapter |
| **Pete 📬** | Email send | SES v2 |
| **Polly 🔊** | Text → voice | Amazon Polly |
| **Tina 🎙️** | Voice → text | Amazon Transcribe |
| **Vex 🧭** | Semantic search | S3 Vectors |
| **Vinnie 📦** | Generated files | `claudeclaw-raw` S3 |
| **Annie 🗄️** | Logs + DDB exports | `claudeclaw-logs` S3 (Glacier 90d) |
| **Sealed Sam 🔒** | Audit immutability | `claudeclaw-audit-lock` S3 (Object Lock) |
| **Cathy 📁** | Config | `claudeclaw-config` S3 |
| **Curated Curt 📚** | Cleaned-up docs | `claudeclaw-curated` S3 |
| **Stage Stu ⏳** | Ingest staging | `claudeclaw-vectors-staging` S3 |
| **Beth ⏰** | Daily DDB backup at 02:00 UTC | A4 BackupLambda |
| **Winnie 👀** | Alarms + dashboards | CloudWatch |
| **Sentry Sam 👮** | Threat detection | GuardDuty (B2) |
| **Luca 🔑** | KMS keys | 3 customer-managed CMKs |
| **Victor 🗝️** | Secret storage | Secrets Manager |
| **Dave 🚀** | CI deploys | GitHub Actions + OIDC (A2) |
| **Calendar Cal 📆** | In-process scheduler tick | `src/agent/scheduler.ts` |
| **Canary Coco 🐦** | Synthetic test turn every 5 min | `src/agent/canary.ts` |
| **Config Conrad 📋** | Compliance recording | AWS Config (B2, gated) |
| **Ratel Ronnie ⚡** | Rate limiter inside the WAF | WAFv2 rate-based rule |
| **Hot-reload Hattie ♻️** | Agent config fan-out | SNS → SQS per-task → in-memory reload |
| **Cost-cap Casey 💰** | Daily budget watcher | `getDailyCostUsd` + kill switch |

### Reading the arrows

- **Solid blue** = the live conversation (request path)
- **Solid green** = the reply path back to the user
- **Dashed gray** = always-on background helpers that don't sit on the request path

### Layout

Eight zones, top → bottom:

1. Where people say hi (the three surfaces)
2. The gatekeepers (front door — Eddie / Wally / Bob)
3. The conductor (Carla + Dex)
4. The library (DDB)
5. The wise advisor (Bedrock + Guardrail)
6. The helper crew (tools)
7. The warehouse (S3)
8. Behind the scenes (always-running helpers)
