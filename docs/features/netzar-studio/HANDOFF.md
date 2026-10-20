---
feature: netzar-studio
document_role: handoff
status: current
observed_at: 2026-10-20
as_of_commit: d1d3a66970cd548f9529a234ef2b51ecdc29378e
---

# Netzar Studio rebuild handoff

## Current state (2026-10-20)
- Planning complete; blueprint accepted; backlog of 40 tasks (178 pts) across cycles C0–C3.
- Plane project `Netzar Rebuild` (`NZR`) mirrors the backlog; this folder is the source of truth.
- No product code changed. Base: `development` at `d1d3a66`.

## Next action
C0: close the engineering factory's three sandbox blockers (NZR-1), final review (NZR-2), clean builder clone (NZR-3),
route models in the factory (NZR-40), then register this repo with the factory (NZR-4). No product code until the C0 gate passes.

## Open owner items
- Network installs for UI build/test (`npm ci --prefix web`, Playwright chromium).
- NVIDIA-hosted models for development (test data only).
- Real testers for the end of C2 (owner lines them up).
- New AWS account (Bedrock) for staging; until then everything is proven locally.

## Session log
- [2026-10-20 blueprint and plan](handoffs/2026-10-20-blueprint-and-plan.md)
