# Architecture Decision Records

One file per non-obvious architectural choice. Use these to answer "why did we do X this way?" without having to ask in chat or dig through commit history.

## Format

Each ADR has four sections:

- **Context** — what was true at the time, what tension we were trying to resolve
- **Decision** — what we chose
- **Consequences** — what good and bad things follow from the choice
- **Alternatives considered** — what we said no to and why

Keep ADRs short (1 page). When a decision is reversed, write a new ADR that supersedes the old one. Don't edit history.

## Index

| # | Title | Status |
|---|---|---|
| [0001](0001-tier-framework.md) | T0–T3 tier framework | Accepted |
| [0002](0002-single-tenant.md) | Single-tenant deploy model | Accepted (revisit for E1 strategic track) |
| [0003](0003-bedrock-inference-profiles.md) | Cross-region inference profiles | Accepted |
| [0009](0009-mission-container-model.md) | Missions become a work container, not a task row | Accepted |

## Future ADRs to write (when we touch the related areas)

- 0004 — Deterministic resource naming with `CCE_NAME_SUFFIX` (A3 refactor)
- 0005 — ALB origin-gate two-phase rollout (B1)
- 0006 — EMF over PutMetricData for per-tool metrics (D2)
- 0007 — Manual-dispatch deploy gate as A5 (GitHub Free plan workaround)
- 0008 — Pattern-1 (deploy-per-customer) vs Pattern-3 (multi-tenant refactor)
