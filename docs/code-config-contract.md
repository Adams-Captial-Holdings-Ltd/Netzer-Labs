# The code/config separation contract

> Plain English: the files in this repository are CODE, and everything
> that makes your install yours, tokens, settings, prompts, knowledge,
> lives outside the repository in your `.env` file, AWS Secrets Manager,
> the runtime-config table, and the S3 config bucket. You update by
> checking out a new release tag, never by editing tracked files, so an
> update can never collide with your configuration. If you do change the
> code itself, you have forked, and this page gives you the supported
> rebase path instead of silent divergence.

This is a hard rule, not a convention: **the repo is code; ALL operator
state lives outside it.** It is what makes `npm run update` (item 42 of
the readiness plan) a clean tag checkout instead of a three-way merge
against your customizations.

## Where every kind of operator state lives

| State | Lives in | Written by | Never in |
| --- | --- | --- | --- |
| Account, region, tier, domain, feature flags | `.env` (gitignored; annotated reference: [.env.reference](../.env.reference)) | `npm run setup`, `npm run deploy` | tracked files |
| Surface tokens, dashboard token, encryption keys, vendor API keys | AWS Secrets Manager (`/claudeclaw/*` paths) | setup/deploy secret seeding | `.env` committed anywhere, tracked files |
| Live tunables (cost caps, worker toggles, MCP registry) | DynamoDB `claudeclaw-runtime-config` table | dashboard Config tab, `npm run seed` | source constants you edit |
| Agent system prompts and per-agent config | S3 config bucket (`agents/<id>/CLAUDE.md`, `agents/<id>/agent.yaml`) | dashboard / S3 upload | the repo's `examples/` (those are templates) |
| Knowledge documents and vectors | S3 raw/curated/vectors buckets | knowledge ingest | the repo |
| Deploy state (manifests, journal, lock) | the state bucket + lock table | the lifecycle tooling | the repo |

If you find yourself editing a TRACKED file to configure your install,
stop: the value belongs in `.env` or runtime-config, and if the code
gives you no way to set it there, that is a feature request (or a fork,
below), not an edit.

## How adopters clone and update

Clone with an `upstream` remote so release tags are fetchable:

```bash
git clone https://github.com/<your-fork-or-org>/claudeclaw-enterprise.git
cd claudeclaw-enterprise
git remote add upstream https://github.com/<upstream-org>/claudeclaw-enterprise.git
git fetch upstream --tags
```

Updating is checking out a release tag, never merging configuration:

```bash
git fetch upstream --tags
git checkout v1.3.0          # or: npm run update (item 42), which does this verified
```

Because no operator state is tracked, the checkout is conflict-free by
construction. Your `.env`, your secrets, your runtime-config rows, and
your S3 prompts are untouched by any update.

## The drift check

`npm run doctor` warns when tracked files are locally modified (a
read-only `git status --porcelain` scan). That warning is the EARLY
WARNING for future merge pain: a modified tracked file means your next
tag checkout can conflict, and it usually means configuration leaked
into code. Move the value to `.env` or runtime-config, restore the file,
and the warning disappears.

## Fork-and-modify: the supported rebase path

Changing the code is legitimate, but it is a fork, and forks get a
documented rebase path instead of silent divergence:

1. Keep your changes on a branch, never on detached release tags:

   ```bash
   git checkout -b my-customizations v1.2.0
   ```

2. When a new release ships, fetch and REBASE your branch onto the new
   tag (rebase, not merge, so your delta stays a readable patch series):

   ```bash
   git fetch upstream --tags
   git rebase v1.3.0 my-customizations
   ```

3. Resolve conflicts in your commits only, then rebuild and deploy from
   YOUR code with `--build-local`. A forked tree must never run an
   upstream prebuilt image that does not match its code, and the updater
   refuses exactly that (item 42):

   ```bash
   npm run deploy -- --build-local
   ```

4. Re-run the gates you rely on (`npm test`, `npm run doctor`) before
   shipping the rebased branch.

The smaller your delta, the cheaper every future rebase. If a
customization is generally useful, upstream it and shrink your fork.

## Related

- [lifecycle.md](lifecycle.md), the deploy/rollback/teardown machinery
  that assumes this contract.
- [github-to-aws.md](github-to-aws.md), the deploy-tag namespace that
  keeps upstream release tags inert in your fork.
- [UPGRADING.md](UPGRADING.md) and [deprecations.json](deprecations.json),
  how contract changes are declared release over release.
