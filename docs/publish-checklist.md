# Publish checklist (the item-30 gate)

> Ordered, blocking checklist for cutting this repository to a public remote.
> Two steps are automated (`scripts/publish/publish-gate.sh` and
> `scripts/publish/orphan-export.sh`); everything else is a manual step that
> a script cannot honestly perform for you. Do the steps in order; each one
> assumes the previous ones passed.

## What is automated vs manual

| Step | Automated? | Tool |
| --- | --- | --- |
| 1. Full-history secret + personal-value scan | YES | `scripts/publish/publish-gate.sh` |
| 2. Orphan-export decision + export + re-scan | YES (export + re-scan; the decision is yours) | `scripts/publish/orphan-export.sh` |
| 3. Secret rotation | NO (manual, external systems) | checklist below |
| 4. Fresh-clone smoke matrix in a scratch account | NO (manual, live AWS) | checklist below |
| 5. Repo settings (description, topics, Discussions) | Scriptable via `gh api` (`scripts/launch/repo-settings.sh`) | checklist below |
| 6. Social-preview image | NO (GitHub exposes no API for it) | checklist below |

## 1. Full-history scan (automated)

```sh
cp scripts/publish/personal-values.example.txt scripts/publish/personal-values.txt
# fill personal-values.txt with the REAL values from the private checkout
# (account id, domains, handles, chat ids); the file is gitignored
scripts/publish/publish-gate.sh
```

- Scans ALL refs, not the working tree: a secret deleted three commits ago is
  still one `git log -p` away. Uses `gitleaks` if installed, else
  `trufflehog`, else a documented `git grep` loop over `git rev-list --all`.
- The personal-value list is scanned in every case; the generic tools cannot
  know your account id or domains.
- The gate hard-fails if `personal-values.txt` is missing or empty. A scan
  without the real values certifies nothing.

## 2. Orphan-export decision

- History scan CLEAN: you may publish this repository directly. Skip to
  step 3.
- History scan has ANY hit: do NOT push this repo and do NOT attempt a
  history rewrite (filter-repo/BFG leave reflog and fork traps). Publish a
  fresh orphan-commit export of the current tree instead, the same way the
  public OS repo is cut:

  ```sh
  scripts/publish/orphan-export.sh /path/to/export-dir
  ```

  The script exports the tracked tree at HEAD (gitignored files never
  travel), creates a single orphan commit, re-runs the scan on the export
  (with `personal-values.txt` as an extra denylist), and prints the
  remote-add/push commands. It never pushes anything itself.

## 3. Secret rotation (manual)

Anything that ever sat in a local `.env` is burned once the repo is public,
even with a clean history scan, because the code documents exactly where each
value is used. Rotate, then force a new ECS deployment (secrets inject at
task START):

- [ ] Telegram bot token (BotFather revoke + reissue, update Secrets
      Manager, re-register the webhook)
- [ ] Dashboard token (reissue, update Secrets Manager)
- [ ] Encryption key (rotate per `docs/lifecycle.md`)
- [ ] Webhook secret (rotate, re-run Telegram `setWebhook`)
- [ ] Kill phrase (set a new one in runtime-config)

## 4. Fresh-clone smoke matrix (manual, scratch account)

The release matrix from plan item 38, executed from a FRESH CLONE in a
scratch account. Both modes block the initial publish because the README
leads with chat:

- [ ] `infra-only` mode: preflight -> deploy -> verify -> image rollback ->
      secret-version rollback -> teardown (including the break-glass drill) ->
      residuals match the documented intentional list exactly
- [ ] `chat` mode (Telegram fixture, the cheaper surface to maintain): the
      same full lifecycle with the chat surface verified end-to-end

No local build artifacts may leak into the run; the point is proving the
public repo alone is sufficient.

## 5. Repo settings (scripted half)

Description, homepage, topics, and Discussions are settable via `gh api` /
`gh repo edit`; run `scripts/launch/repo-settings.sh` (idempotent — it sets the
description, homepage, topics, Discussions, and merge hygiene). To set them by
hand instead, and record what was set:

- [ ] Description + homepage
- [ ] Topics
- [ ] Discussions on/off decision
- [ ] Default branch protection / rulesets

## 6. Social-preview image (manual, always)

GitHub exposes NO API for the social-preview image. Upload it by hand under
Settings -> General -> Social preview, then verify with a link expander
(Slack/Twitter card preview). This step stays manual forever; do not let a
file-only checklist convince you it happened.

## Done

- [ ] Steps 1-6 all checked
- [ ] The push to the public remote was made from the export (step 2) or the
      verified-clean repo (step 1), nothing else
