# ClaudeClaw Enterprise documentation

> Everything in this folder is organized by what you are trying to do, not by which subsystem a page describes: deploy it, understand it, run it in production, or extend it. Every page opens with a short plain-English summary like this one, then goes technical, so you can skim the summaries and only dive where you need to. Start with the track that matches you; the [glossary](./glossary.md) decodes the project-specific words along the way.

The top-level [README](../README.md) is the landing page; this folder is the depth.

---

## I want to deploy this

The operator quickstart, in order: AWS-side prerequisites first (standalone account, AWS CLI v2 with working credentials, Node 20+; Docker optional, deploys can build in CodeBuild; handheld in [aws-getting-started.md](./aws-getting-started.md)), then `npm ci --ignore-scripts`, then ONE command: `npm run up`. It conducts the whole install (setup wizard, read-only preflight, a bounded model probe, the phased deploy, strict verify) and, at a human gate like the Bedrock model-access grant, prints one instruction with the console URL and keeps re-checking until it clears. Unattended: `npm run up -- --answers <file> --yes` with a template from [examples/answers/](../examples/answers/README.md). The three commands underneath, for driving yourself: `npm run setup` (interactive wizard), `npm run deploy` (preflight, bootstrap-state, phased stacks, secrets, seed), `npm run verify` (the gate that says it actually works).

- **Pointing an AI coding agent at the repo**: it reads [AGENTS.md](../AGENTS.md) at the repo root (the short runbook) and drives the same `npm run up`. No extra instructions needed.
- **The agent-driven cold-start runbook** (`docs/agent-setup.md`): the self-contained, phase-ordered install an AI coding agent (or a human) follows to go from a freshly cloned repo to a verified single-tenant deploy in a brand-new standalone AWS account, with typed envelopes, named human gates, a TTL tripwire, and `npm run destroy` to stop: [agent-setup.md](./agent-setup.md). Its AWS-side prerequisites (standalone account, AWS CLI v2, credentials, Bedrock access) are handheld step by step, for a human or a partner agent, in [aws-getting-started.md](./aws-getting-started.md).
- **Deploy modes**: `chat` (at least one webhook surface, needs HTTPS/domain) vs `infra-only` (dashboard only; without a domain the ALB is internal and access is `npm run dashboard:tunnel`). The modes, readiness semantics, and what each requires are explained in [how-it-works.md](./how-it-works.md) and enforced by the checks below.
- **`npm run doctor`**, the read-only pre-deploy preflight (also auto-run by deploy). Every check id, why it fails, and the exact fix: [troubleshooting.md](./troubleshooting.md).
- **`npm run verify`**, the post-deploy gate (CloudFormation-derived checks, manifest/value checks, external + Bedrock probes). Same page: [troubleshooting.md](./troubleshooting.md).
- **What it will cost**, per tier, with stated assumptions and a recalculable estimator: [cost-guide.md](./cost-guide.md).
- **What data leaves your account** (read this before putting real data on it): [security-model.md](./security-model.md), backed by the machine-readable [data-flows.json](./data-flows.json).
- **Connecting Telegram or Slack to an agent**, no redeploy needed: [channels/connect-prompts.md](./channels/connect-prompts.md) and the Slack-specific setup + app manifest in [slack/README.md](./slack/README.md) ([app-manifest.json](./slack/app-manifest.json)).
- **A second parallel environment** (staging): [staging.md](./staging.md).
- **Connecting GitHub to AWS** (optional: you do not need CI to deploy; the two accelerators, OIDC deploys and CodeBuild tag deploys, and their trust scopes): [github-to-aws.md](./github-to-aws.md).

## I want to understand it

- **How a message becomes a reply**, one real Telegram message end-to-end, told in plain English and then at code level, with the Slack deltas and the `infra-only` path: [how-it-works.md](./how-it-works.md).
- **The diagram suite**, maintained Mermaid diagrams split by concern: [diagrams/README.md](./diagrams/README.md) is the index. Direct links: [compute](./diagrams/architecture-compute.md), [data](./diagrams/architecture-data.md), [messaging](./diagrams/architecture-messaging.md), [security / trust boundaries](./diagrams/architecture-security.md), [request lifecycle](./diagrams/request-lifecycle.md), [deploy pipeline](./diagrams/deploy-pipeline.md), [rollback classes](./diagrams/rollback-classes.md), [teardown decision tree](./diagrams/teardown-decision-tree.md). Each diagram is tied to the code it depicts via [diagrams.map](./diagrams.map).
- **Why it is built this way**, the architecture decision records: [adr/README.md](./adr/README.md), covering the [tier framework](./adr/0001-tier-framework.md), [single-tenancy](./adr/0002-single-tenant.md), and [Bedrock inference profiles](./adr/0003-bedrock-inference-profiles.md).
- **The security model**: IAM roles and blast radius, secrets, audit retention, network posture, the narrow telemetry claim: [security-model.md](./security-model.md).
- **The vocabulary**: [glossary.md](./glossary.md).

## I run it in production

- **The lifecycle runbook**, the four rollback classes (image / infra / config / data) and the disruptive data-restore procedure, plus teardown context: [lifecycle.md](./lifecycle.md).
- **The operator-handover runbook**, `npm run handover`: the state inventory, the access-transfer checklist, the command-owned vs external credential classification, and the config-epoch mechanism that fails a stale `.env`: [handover.md](./handover.md).
- **The out-of-band resource catalog**, everything `cdk destroy` cannot see, which teardown loads as an inventory source: [out-of-band-catalog.md](./out-of-band-catalog.md) (machine-readable: [out-of-band-catalog.json](./out-of-band-catalog.json)).
- **Operational runbooks**, one per recurring task, indexed at [runbooks/README.md](./runbooks/README.md):
  - [deploy-validation.md](./runbooks/deploy-validation.md), prove a deploy shipped a working task definition
  - [rollback-bad-image.md](./runbooks/rollback-bad-image.md), revert a broken image in ~60 seconds
  - [kill-switches.md](./runbooks/kill-switches.md), trip or disarm runtime feature gates
  - [rotate-dashboard-token.md](./runbooks/rotate-dashboard-token.md) and [rotate-cf-origin-secret.md](./runbooks/rotate-cf-origin-secret.md), credential rotation
  - [restore-from-ddb-export.md](./runbooks/restore-from-ddb-export.md), point-in-time DynamoDB restore
  - [debug-no-telegram-response.md](./runbooks/debug-no-telegram-response.md) and [debug-no-slack-response.md](./runbooks/debug-no-slack-response.md), the bot went quiet
  - [scale-up-for-traffic-burst.md](./runbooks/scale-up-for-traffic-burst.md), pre-scale before a load spike
  - [force-cf-invalidation.md](./runbooks/force-cf-invalidation.md), evict a stale edge-cached asset
  - [chaos-testing.md](./runbooks/chaos-testing.md), run the FIS kill-task experiment and the in-app fault-injection switches
- **Edge operations (T3)**: the CloudFront apex DNS flip: [cloudfront-cutover.md](./cloudfront-cutover.md). An alternative zero-trust access path via Cloudflare Tunnel: [tunnel-setup.md](./tunnel-setup.md).
- **When something fails a check**: [troubleshooting.md](./troubleshooting.md). **When the bill looks wrong**: [cost-guide.md](./cost-guide.md).

## I want to extend it

- **Agents**: an agent is a CLAUDE.md + `agent.yaml` + model selection, created from the dashboard with no process of its own; see the agent concepts in [glossary.md](./glossary.md) and the surface-parity rules in the repo's [CLAUDE.md](../CLAUDE.md).
- **Give agents tools with MCP**: AgentCore gateways (IAM-auth, no stored secrets) or vendor remote MCP servers (bearer), registered live in runtime-config: [mcp/README.md](./mcp/README.md).
- **Surfaces**: how the Telegram exemplar works and exactly where Slack and the dashboard differ, including the two Slack send paths you must keep in parity: [how-it-works.md](./how-it-works.md).
- **Connecting new channels per agent**: [channels/connect-prompts.md](./channels/connect-prompts.md), [slack/README.md](./slack/README.md).
- **Before you ship**: run the FULL `npm test` (not a scoped run), keep diagrams in sync per [diagrams.map](./diagrams.map), and mirror chat-UX changes across all three surfaces.
- **Cutting a public release of the repo itself** (maintainers): [publish-checklist.md](./publish-checklist.md).
- **How releases are signed, promoted, and consumed** (the rc flow, the updater shim's verify-then-exec contract, image import to private ECR, `--build-local` for forks, `npm run update`): [release-pipeline.md](./release-pipeline.md).

---

## House style for pages in this folder

Every page starts with a 3-sentence plain-English summary in a blockquote, then the technical detail. All internal links are relative, so a tag's docs describe that tag. No em dashes; write for two registers, plain English first, depth after.
