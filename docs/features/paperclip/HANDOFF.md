---
feature: paperclip
document_role: handoff
status: current
observed_at: 2026-08-21
as_of_commit: c230a0a
---

# Paperclip integration handoff

- **Branch: `feature/paperclip-phase-1-5`.** Phases 1 and 1.5 are **merged**
  into `development` as
  [PR #88](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/88),
  squashed, 9/9 CI checks green. **Phase 2 (the client)** and **Phase 4 (the
  service stack and tenant bootstrap)** are committed on the branch and open as
  [PR #89](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/89).
- **Deployment: nothing.** No AWS resource has been created by this work. The
  session made read-only AWS calls only. `development` deploys nothing.
- **Phases complete:** §33 first milestone, Phase 0, Phase 1 (substrate code),
  Phase 1 (contract probes and wire types), Phase 1.5 (image pipeline),
  **Phase 2 (the client)** and **Phase 4 (service stack and tenant bootstrap)**.
- **Active work:** Phase 4.5 (operator console) and Phase 5 (the reconciler) are
  the next two. Phase 4.5 is deliberately **deferred behind Phase 5**: the
  reconciler is the critical path for Phases 6, 7 and 8, while the console is a
  side branch.

## The single next action

**Build Phase 5, the reconciler** — then hold the `qa → staging` promotion until
the two deploy blockers below are cleared by hand.

Phase 4's gauntlet is finished: its critic shipped it at round 3 and the blind
judges preferred it to this repository's own `database-stack.ts` 2 of 3 in every
round. A staging deploy is now worth doing — it would give a running Paperclip
with its own board — but it is **still blocked on two things nobody has done**:
the orphaned `/claudeclaw-staging/paperclip` log group must be deleted first
(**M19**, **P21**), and CI populates no secrets (**A26**), so the new
`Populate Paperclip secret` step only runs when the repository variable
`CCE_PAPERCLIP_ENABLED` is set to `1`. Both are AWS/GitHub actions, not code.

## What changed on 2026-08-21

### Committed on the branch, in PR #89

| Commit | What |
|---|---|
| `c230a0a` | Phase 2 — the client, its errors, config, agent map and the mission-engine seam. Shipped at round 5; **15 of 15 blind judges** picked it over Linear's own `error.ts` with the order flipped each round |

### Merged

| Commit | What |
|---|---|
| `b0f6979` | Phase 1 — one wire-types file, **21 live contract probes**, the real 475-path OpenAPI snapshot, and a committed characterization of the answers a future artifact bump could silently flip |
| `7e17a7c` | Phase 1.5 — the patched image builds on **one** path across both deploy drivers, content-addressed so unrelated commits do not rebuild it, plus the staging IAM grants |
| `78715f6` | [The bar and phase decomposition](bar-and-phases.md), §35 of the plan, the session handoff |
| `45a96a8` | The deploy-pipeline diagram split (a node-budget fix) |

### The three findings most worth carrying forward

1. **Paperclip silently ignores unknown query parameters.** An unpatched build
   answers `updatedSince` with a **200 and the full unfiltered list**. That is a
   silent data-correctness trap and the failure a reconciler is least able to
   detect. Guarded by the A1-8 boot probe, which must run before the reconciler
   starts.
2. **The pinned image already ships its built UI.** `/app/ui/dist` exists; the
   server looks at `../ui-dist`. One symlink and `SERVE_UI=true` serves the real
   SPA — verified, `GET /` 200 with a 6,484,747-byte bundle. §16.6's "rebuild it
   in Preact" ruling is amended: its four reasons argue for controlling *access*
   to that UI, not rewriting it. See [Part F](bar-and-phases.md).
3. **A readiness gate can be catastrophic in the other direction.** Phase 4's
   critic found the service's existence recomputed each deploy from a
   gitignored, machine-local file whose failure default was **DELETE** — so a CI
   deploy would have torn down a running Paperclip service and exited 0. Same
   shape as the cloudflared post-mortem.

## Blockers

1. **Phase 4 is rejected and uncommitted.** Its fix round is the next thing to
   finish. Until it lands, the tree cannot change branches cleanly.
2. **The `qa → staging` merge IS the deploy.** `CCE_PAPERCLIP_ENABLED=1` is
   already set at repo level and staging deploys automatically on push to
   `staging`. It creates a retained, deletion-protected Aurora cluster billing
   from creation. This is a deliberate author decision (Paperclip is a
   chargeable extra, every tier, no Tier 0 carve-out) — but it should happen
   once, after Phase 4.
3. **CI populates no secrets** (**A26**). `put-secret-value` appears zero times
   in `.github/workflows/deploy.yml`, so `/claudeclaw-staging/paperclip` stays
   `REPLACE_ME` on the CI path. A container treating it as essential fails its
   rollout the way the cloudflared connector did.
4. **Open self-registration**, probed live: `POST /api/auth/sign-up/email`
   returns **200 with no credential** even in
   `PAPERCLIP_DEPLOYMENT_MODE=authenticated`. This matters the moment the UI is
   reachable.
5. **Before Phase 7**, the GDPR hole (**C-11**) must be closed:
   `privacy-tools.ts` filters a subject's missions by `createdByChat === chatId`
   while the projection hardcodes `'paperclip'`, so every Paperclip-origin
   mission silently vanishes from a user's data export.

## Two blockers that turned out to be stale

Both were carried across three handoffs and neither exists. Verified read-only
against the account on 2026-08-21: **zero** log groups matching `paperclip`,
**zero** EFS filesystems. Nothing needs deleting before a staging deploy. This
is **M26** repeating — a blocker phrased as work-to-do was a question that could
be answered by looking.

## Remaining phases

In order, from [the decomposition](bar-and-phases.md): **2** (the client, judged
against Linear's SDK — the largest unbuilt piece), **4/4.5** (in flight), **5**
(reconciler), **6** (dispatch), **7** (ACL cutover), **8** (cross-surface
parity), **8.5** (org and goals), **8.6** (delegation), **9** (install by
default), and **10–12** (the three Paperclip pillars Netzar surfaces as the
Agentic OS).

## Session log index

Newest first. Every session working in this folder adds one file to
`handoffs/`, copied from the
[session handoff template](../HANDOFF-TEMPLATE.md), and links it here.

| Session | Date | Summary |
|---|---|---|
| [Paperclip end to end](handoffs/2026-08-21-paperclip-end-to-end.md) | 2026-08-21 | Established the three-part bar from primary sources; built and landed Phases 1 and 1.5 through a builder/critic gauntlet; proved the shipped UI serves; found the staging IAM gap and the DELETE-default readiness gate |
| [Image pipeline and Phase 2](handoffs/2026-08-20-image-pipeline-and-phase-2.md) | 2026-08-20 | Interrupted session; its ledger is carried forward |
| [Phase 2 readiness](handoffs/2026-08-20-phase-2-readiness.md) | 2026-08-20 | Verified the blocker list instead of trusting it; proved the ARM64 precondition was already met |
| [Phase 1 ponytail audit](handoffs/2026-08-19-phase-1-ponytail-audit.md) | 2026-08-19 | Found the `CCE_PAPERCLIP_ENABLED` gate was mirrored in one place of five and failed silently |
| [Org transfer, OIDC and staging deploy](handoffs/2026-08-19-org-transfer-oidc-and-staging-deploy.md) | 2026-08-19 | Diagnosed the red staging deploy to the org's immutable OIDC subject claims |
| [Documentation consolidation](handoffs/2026-08-19-docs-consolidation.md) | 2026-08-19 | Vendored the implementation plan and its audit into the repo |
| [updated-since patch + Phase 0/1](handoffs/2026-08-18-updated-since-patch-and-phase-0.md) | 2026-08-18 | Resolved the I3 blocker via the approved artifact patch; wrote ADR 0010 |
| [Codex deep dive](handoffs/2026-08-18-codex-review.md) | 2026-08-18 | The origin session; proved the pinned release has no `updatedSince` |

Authorities: [README](README.md),
[the bar and phase decomposition](bar-and-phases.md),
[ADR 0010](../../adr/0010-paperclip-work-engine.md),
[ADR 0009](../../adr/0009-mission-container-model.md),
[implementation plan](implementation-plan.md), [plan audit](plan-audit.md).
