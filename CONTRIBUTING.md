# Contributing to ClaudeClaw Enterprise

Thanks for contributing. This page covers local dev setup, the test contract,
PR conventions, and how releases are cut. Working conventions for *changing
the product* (surface parity, MCP config, agent prompts) live in
[CLAUDE.md](CLAUDE.md) and apply to humans and agents alike.

## Dev setup

Prerequisites:

- **Node 20** (`engines` is `>=20`; CI runs on 20)
- **Docker** (only needed for integration tests and image builds)
- No AWS account is needed for unit tests, typecheck, or CDK synth — the test
  suite runs against injected fakes.

```bash
git clone <your fork>
cd claudeclaw-enterprise
npm ci
```

Day-to-day commands:

| Command                        | What it does                                              |
| ------------------------------ | --------------------------------------------------------- |
| `npm run typecheck`            | `tsc --noEmit` over src/, infra/, scripts/                |
| `npm test`                     | full unit suite (vitest, AWS clients are fakes)           |
| `npm run test:integration:all` | LocalStack integration tests via `docker-compose.test.yml` (`up -d --wait`, run, `down -v`) |
| `npm run synth`                | CDK synth (no AWS credentials needed with `DOMAIN_NAME` unset) |
| `npm run dev`                  | local orchestrator with `.env`                            |

## Before you push

**Run the FULL `npm test` before pushing, not a scoped run.** This is a repo
rule (see CLAUDE.md): scoped runs hide cross-cutting regressions, and main CI
treats a red suite as a blocked merge. Also run `npm run typecheck`.

If your change touches docs, the docs CI gates run hermetically per PR
(`.github/workflows/docs-ci.yml`): internal link/anchor check, Mermaid render
check, `docs/diagrams.map` drift gate, and asset size budgets. You can run
them locally:

```bash
node scripts/ci/docs-links.mjs
node scripts/ci/diagrams-drift.mjs
node scripts/ci/runnable-blocks.mjs
node scripts/ci/docs-mermaid.mjs   # downloads the pinned mermaid-cli via npx
```

If your change touches a source file mapped in `docs/diagrams.map`, update the
corresponding diagram in the same PR (or get the diagram owner's approval) —
the drift gate fails otherwise.

## Branch and promotion workflow

Normal work and promotions move in one direction:

```text
feature/fix/chore -> development -> qa -> staging -> production
hotfix/<issue> -> production, then backport to development and promote normally
```

- Start ordinary work from `development` and open a pull request back to
  `development`. Ordinary work never targets `production` directly.
- Promotion branches accept normal changes only from the immediately preceding
  branch: `development` into `qa`, `qa` into `staging`, and `staging` into
  `production`.
- `development`, `qa`, `staging`, and `production` are the only long-lived
  branches. Use pull requests for every promotion. Force pushes, branch
  deletion, and history rewriting are forbidden on those four.
- Every other branch is transient. Delete it once it merges, so the branch list
  never grows past what someone can read in one screen and a handoff that names
  a branch names something that still exists.
- For an urgent production fix, branch `hotfix/<issue>` from `production`,
  merge the smallest verified fix into `production`, then backport it to
  `development` and promote that backport normally.
- Feature documentation follows the
  [feature knowledge framework](docs/features/README.md). A PR that adds or
  changes a `docs/features/<slug>/` document must conform to it; Docs CI
  enforces the contract.

The operator sequence and stop conditions are in [cutover.md](cutover.md).

## PR conventions

- One logical change per PR. Describe **what changed and why**, not a file
  list.
- Chat-surface UX changes must be mirrored across Telegram, Slack, and the
  dashboard (or explicitly declared as skipped, with a code comment at the
  skipped call site). See CLAUDE.md → "Chat surface parity".
- Commit style is conventional-ish, matching the existing history:
  `feat(scope): ...`, `fix(scope): ...`, `docs: ...`, `chore: ...`. Scopes in
  use include `iac-readiness`, `jarvis`, `dashboard`, `slack`, `mcp`. Imperative
  mood, lower-case subject, no trailing period.
- Issue reports attached to PRs should use the redacted support bundle
  (`npx tsx scripts/support-bundle.ts`) — never raw `verify` output, which
  publishes the poster's AWS posture.

## Releases and release notes

- Releases are cut as semver-ish **`v*` git tags** (`v1.2.3`). Every release
  carries human-readable UPGRADING notes (breaking changes, new env vars, new
  Bedrock grants) plus machine-readable release metadata that the updater and
  dashboard consume.
- Release notes are organized by impact, not by commit: **Breaking /
  Required actions**, **Features**, **Fixes**, **Docs**. The conventional-ish
  commit prefixes above are what make this grouping cheap.
- **Namespace split** (see [docs/github-to-aws.md](docs/github-to-aws.md)):
  `v*` is the RELEASE namespace — inert, identifies an upstream release.
  `deploy/v*` is the DEPLOY TRIGGER namespace — pushing `deploy/v1.2.3` is
  what authorizes CodeBuild to deploy `v1.2.3` to an install. Contributors
  only ever create `v*` history via maintainers cutting a release; nobody
  pushes `deploy/v*` to this repo's CI from a PR.
- Docs are versioned with the code: docs links are relative, so a tag's docs
  describe that tag. If your PR changes behavior, change the docs in the same
  PR.

## Security issues

Never open a public issue or PR for a vulnerability — see
[SECURITY.md](SECURITY.md) for the private reporting path.
