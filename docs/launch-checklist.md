# Launch checklist — at-publish steps that are not files

> Plain English: most of this repo's quality gates are files that CI runs.
> This page is the rest — repository settings, rulesets, images, and
> release-time checks that must be done (and verified) when the repo goes
> public. It is split by mechanism: what `gh api` can set is scripted; what
> only the browser can do is a manual, verified step. Both halves run at
> publish time so a file-only checklist can't miss them.

Covers IaC readiness items 36 (GitHub-native polish), 37 (visual proof), and
40 (docs CI arming). The repo-content publish gate (full-history secret scan,
orphan export, secret rotation, fresh-clone smoke test) is item 30 and lives
in [docs/publish-checklist.md](publish-checklist.md) — run that FIRST; this
page is what comes after the content is clean.

## 1. Scripted repo settings (`gh api` CAN set these)

Run [`scripts/launch/repo-settings.sh`](../scripts/launch/repo-settings.sh)
after editing the variables at the top of the script. It sets, idempotently:

- [ ] repository **description**
- [ ] **homepage** URL
- [ ] **topics** (discoverability: `aws`, `bedrock`, `cdk`, `ai-agents`, ...)
- [ ] **Discussions** enabled (the issue-template `config.yml` links to it —
      a dead link there is the first thing a confused user sees)
- [ ] merge hygiene: squash merge on, merge commits off, delete branches on merge

Then verify in the browser that the description/topics render on the repo
landing page.

## 2. Manual settings (NOT API-settable — verify each in the browser)

- [ ] **Social-preview image**: Settings → General → Social preview → upload
      `docs/assets/` hero/social image (1280×640). The GitHub API has no
      endpoint for this; it cannot be scripted. Verify with a link unfurl
      (paste the repo URL into Slack) before announcing.
- [ ] **Branch ruleset on `main`** (Settings → Rules → Rulesets):
  - require a PR before merging; require status checks: `CI` and all four
    `Docs CI` jobs;
  - **code-owner review required** — this is what makes the CODEOWNERS
    binding on `docs/assets/**` ENFORCED rather than advisory (items 32/37);
  - **dismiss stale approvals on new pushes** — the diagrams-drift gate's
    owner-approval escape hatch assumes a stale review cannot satisfy it.
- [ ] **Tag rulesets** (per [docs/github-to-aws.md](github-to-aws.md), item 39):
  - `v*` (release namespace): creation restricted to release maintainers;
    no deletion, no updates (tags are immutable release identities);
  - `deploy/v*` (deploy-trigger namespace): create/update/delete restricted
    to the deploy role — pushing this tag IS the deploy authorization, so
    whoever can push it can deploy.
- [ ] **Default issue labels** exist: `bug`, `deploy`, `enhancement`,
      `triage` (the issue templates apply them; missing labels are dropped
      silently).
- [ ] **Security advisories enabled** (Settings → Code security) — both
      SECURITY.md and the issue-template config link to private advisories.
- [ ] The already-deferred CI variable: `gh variable set AWS_ACCOUNT_ID`
      (deliberately NOT set until the adopter wires their own CI; the
      Actions OIDC deploy fails closed without it — see
      [docs/github-to-aws.md](github-to-aws.md)).

## 3. Screenshot capture (item 37 — launch-time work)

Marquee set: War Room, Mission Control, Knowledge, Compliance, plus one chat
surface conversation. Rules (the capture tooling itself is NOT built yet —
this defines its contract):

- [ ] Captured ONLY from a **synthetic demo deployment**: seeded fake agents,
      fake data, throwaway account. Never from a real install.
- [ ] Via a **deterministic capture script** so the set is re-shootable when
      the UI changes: fixed window size (1440×900), scripted navigation to a
      fixed route list, fixed seed data, waits on app idle (not sleeps),
      output filenames stable (`docs/assets/screens/<tab>.png`). The
      script lands at `scripts/launch/capture-screenshots.ts` when built;
      Playwright tooling is intentionally not added before launch.
- [ ] Every shot satisfies the [asset contract](assets/README.md):
      provenance sidecar, size budget, alt text at use sites.
- [ ] OCR + metadata scan over the images (no real ids in pixels), reviewer
      approval recorded with asset checksums in the release notes.

## 4. Release-time docs checks (items 30 / 38 — pointers, not duplicates)

Per-PR docs CI is hermetic; these run at RELEASE time:

- [ ] **Docs canary**: execute the quickstart's runnable blocks
      ([contract](runnable-blocks.md)) against the canary environment, AT the
      tag being released — a tag's docs must describe that tag.
- [ ] **Release-blocking matrix** (single source for items 30 + 38): initial
      launch blocks on `infra-only` AND one real chat surface (Telegram
      fixture); routine releases block on `infra-only` always, the chat
      canary when surface-adapter code changed, and the UPGRADE canary
      (previous release → `npm run update` → verify) on every release.
- [ ] **External link check** with retries + allowlist (the per-PR job
      counts external links but never fetches them).
- [ ] Manual smoke-check of Mermaid rendering on github.com (GitHub's
      renderer version has no contract; CI pins its own).
- [ ] Slim or relocate `docs/diagrams/system-flow.excalidraw` (2.3 MB,
      carries a legacy exemption in `scripts/ci/docs-assets.mjs` — the
      exemption list must be empty by launch).

## 5. Last look

- [ ] LICENSE: counsel has replaced the provisional proprietary notice with the
      approved customer licensing structure, confirmed the legal licensor and
      chain of title, and approved the third-party notices. Do this BEFORE the
      repo or binaries reach anyone outside the authorized team.
- [ ] SECURITY.md: replace `<security contact — set at publish>` with the
      real mailbox and confirm it is monitored.
- [ ] Issue-template Discussions link points at the FINAL org/repo name.
- [ ] `scripts/launch/repo-settings.sh` variables match the final repo.
