---
feature: pgnos-public-dashboard
document_role: index
status: current
observed_at: 2026-08-13
as_of_commit: 77a3df9c3ae9d479ba13db6e9374dca19f621ff5
implemented_by:
  - infra/lib/public-dashboard-access.ts
  - infra/lib/compute-stack.ts
  - scripts/lib/public-tunnel/setup.ts
  - scripts/lib/ses/setup.ts
  - scripts/public-setup.ts
  - scripts/email-setup.ts
  - scripts/lib/shell.ts
tested_by:
  - infra/lib/public-dashboard-access.test.ts
  - scripts/lib/public-tunnel/setup.test.ts
  - scripts/lib/ses/setup.test.ts
  - scripts/lib/shell.test.ts
decisions:
  - docs/superpowers/specs/2026-08-11-netzar-os-pgnos-public-dashboard-email-design.md
---

# pgnos public dashboard and email

## 1. Start Here

This describes making the already-deployed production dashboard reachable at
`https://app.pgnos.ai`, and enabling `no-reply@pgnos.ai` as the SES sender.

Reading order: the [approved design](../../superpowers/specs/2026-08-11-netzar-os-pgnos-public-dashboard-email-design.md)
first â€” it is authoritative and the owner confirmed it final â€” then this page,
then [HANDOFF.md](HANDOFF.md) for where the work actually stands right now.

Source code is the ultimate truth for present behavior. Where this page and the
implementation disagree, the code wins.

## 2. What this does today

Production runs `infra-only` with **no domain**: the ALB is synthesized
`internal`, so there is no internet ingress and the only access path is an SSM
port-forward (`npm run dashboard:tunnel`).

This feature does **not** open the ALB. A `cloudflared` sidecar joins the
existing ECS task and dials **outbound** to Cloudflare, which terminates TLS at
the edge and forwards `app.pgnos.ai` to `http://localhost:3000` inside the task.
There is no public task IP, no public listener, and no security-group change.

Netzar OS remains the authentication boundary. There is deliberately no
Cloudflare Access in front of it, so an unauthenticated browser reaches the
Netzar sign-in page and nothing more. `DASHBOARD_TOKEN` is the owner login.

Email is wired end to end â€” the `pgnos.ai` SES identity is DKIM and MAIL FROM
verified, and the task carries `CCE_EMAIL_FROM=no-reply@pgnos.ai` and
`CCE_DASHBOARD_URL=https://app.pgnos.ai` â€” but the account is still in the SES
**sandbox**, so delivery reaches only separately verified identities.

What it is **not** yet:

- Invitations to arbitrary client addresses do not deliver. SES production
  access was **denied** (AWS case `178661777600815`); sends to unverified
  addresses fail-soft and audit as `ses_error`.
- No always-on CloudWatch alarm (design Component 9, deferred).
- No Cloudflare edge rate-limit on the login path yet.

## 3. Current status and current source commit

Verified against `77a3df9c3ae9d479ba13db6e9374dca19f621ff5` on 2026-08-13.

This is **source evidence plus deployment evidence**, and the two are not the
same thing:

- *Source*: components 1, 2, 3 and 5 are implemented and unit-tested.
- *Deployment*: live. Task definition `claudeclaw-orchestrator:5`, 3/3 running,
  carrying `orchestrator`, a digest-pinned essential `cloudflared`, and
  `xray-daemon`. The tunnel reports 12 edge connections.
- `https://app.pgnos.ai/dashboard/` returns **200** with the sign-in SPA, and
  an unauthenticated `/api/agents` returns **401**.

Cloudflare **Error 1033** on this hostname means the tunnel has no connector â€”
i.e. the sidecar is missing or the task is down, not that DNS is wrong.

## 4. Source of truth

| Concern | Authority | Use it for |
|---|---|---|
| Approved architecture | [design spec](../../superpowers/specs/2026-08-11-netzar-os-pgnos-public-dashboard-email-design.md) | What is in and out of scope |
| Safety invariants | [public-dashboard-access.ts](../../../infra/lib/public-dashboard-access.ts) | Flag, hostname, zone rules |
| Connector token handling | [public-tunnel/setup.ts](../../../scripts/lib/public-tunnel/setup.ts) | How the token moves |
| SES identity and DNS | [ses/setup.ts](../../../scripts/lib/ses/setup.ts) | Sender, DKIM, MAIL FROM, DMARC |
| Task shape | [compute-stack.ts](../../../infra/lib/compute-stack.ts) | Sidecar and secret wiring |
| Volatile state | [HANDOFF](HANDOFF.md) | Branch, commands, next action |

## 5. Implementation map

| Area | Verified location | Present behavior |
|---|---|---|
| Access resolver | `infra/lib/public-dashboard-access.ts` | Exact-literal `'1'` opt-in; requires `infra-only` and no `DOMAIN_NAME`; rejects `salessly.io`; `pgnos.ai` only; blank hostname falls back to `app.pgnos.ai` |
| Connector sidecar | `infra/lib/compute-stack.ts` | Digest-pinned `cloudflared`, `essential: true`, secret by `ValueFrom`, gated on connector readiness |
| Token transfer | `scripts/lib/public-tunnel/setup.ts` | `cloudflared` â†’ memory â†’ `PutSecretValue`; never argv, printed, or in `.env` |
| SES lifecycle | `scripts/lib/ses/setup.ts` | Discover-or-create identity, custom MAIL FROM, public DNS plan, sandbox gate |
| SES CLI | `scripts/email-setup.ts` | `npm run email:setup`; â‰¤2 AWS writes; creates no DNS record, sends no mail |
| Windows spawn | `scripts/lib/shell.ts` | Resolves `.bin` shims to their JS entry so `npx cdk` runs without a shell |

## 6. Current business/state rules

- The connector is **never** attached in the same deploy that creates its
  secret. A one-phase deploy would attach an `essential: true` container with no
  valid token and take down a live 3/3 service.
- The `cloudflared` image is **distroless**: no `sh`, no curl. A `CMD-SHELL`
  container health check cannot work and must not be added.
- The connector token travels `cloudflared` â†’ memory â†’ `PutSecretValue` only.
- Every SES DNS record lands on a **subdomain**. The `pgnos.ai` apex carries
  live Microsoft 365 records (`MS=ms53482844`) and must not be touched; SPF and
  the bounce MX therefore sit under `bounce.pgnos.ai`, and DMARC under
  `_dmarc.pgnos.ai`, in monitoring mode (`p=none`) so it can never reject mail.
- SES sandbox is **reported, never worked around**. Recipients are not asked to
  self-verify and the invite-only model is not weakened.
- `salessly.io` and the `claudeclaw` tunnel belong to a different live system
  and are prohibited independently by the resolver, the transfer script, and the
  SES lifecycle.

## 7. Known runtime risks and approved next work

| Risk | Evidence | Approved next work |
|---|---|---|
| SES sandbox blocks invites to arbitrary addresses | `GetAccount` â†’ `ProductionAccessEnabled: false` on 2026-08-13 | Human-gated AWS production-access request |
| Dead connector silently drops public access | `essential: true` restarts the task, but nothing alerts | Component 9, always-on alarm, in `observability-stack.ts` |
| Login path has no edge rate limit | Design Â§"Authentication and membership" | Cloudflare rate-limit rule on the login path |
| `deploy-phases.ts` writes the dashboard secret as `env.X ?? ''` | `scripts/lib/lifecycle/deploy-phases.ts:154-158` | Verify `.env` matches the live secret before every deploy |

## 8. Exact focused and full validation commands

Focused:

```powershell
npx vitest run infra/lib/public-dashboard-access.test.ts scripts/lib/public-tunnel/setup.test.ts scripts/lib/ses/setup.test.ts scripts/lib/shell.test.ts
```

Full pre-push suite, per [development.md](../../../development.md) step 7:

```powershell
npm run typecheck
npm test
npm run build
npm --prefix web run typecheck
npm --prefix web run build
npm run local:test:integration
node scripts/ci/docs-links.mjs
node scripts/ci/feature-knowledge.mjs
git diff --check
```

Do **not** run `npm run test:integration:up`: it starts LocalStack on 4566 and
collides with Floci.

## 9. Related documents

- [Operational HANDOFF](HANDOFF.md)
- [Feature knowledge framework](../README.md)
- [Documentation index](../../README.md)
- [Repository development guidance](../../../development.md)
