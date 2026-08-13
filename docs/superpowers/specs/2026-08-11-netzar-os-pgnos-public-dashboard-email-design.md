# Netzar OS `pgnos.ai` Public Dashboard and Email Design

**Date:** 2026-08-11  
**Status:** Approved architecture; written specification awaiting final review  
**Production hostname:** `https://app.pgnos.ai`  
**Email sender:** `no-reply@pgnos.ai`

## Context

The production T2 deployment is currently `infra-only`. Its dashboard is
reachable through the temporary SSM port forward, and the application email
path is inert because no public dashboard URL or verified SES sender is
configured.

The Cloudflare account now contains an active `pgnos.ai` zone. The existing
`claudeclaw` tunnel and Access application belong to `salessly.io`; they are
outside this change and must not be modified.

This design supersedes the private-hostname WARP access design for the current
production dashboard. The partially implemented WARP branch remains preserved
and is not deployed or silently rewritten. The public-domain implementation
must be developed and reviewed independently.

## Goals

- Keep the production dashboard continuously reachable at
  `https://app.pgnos.ai` from a normal browser on any device.
- Show the Netzar OS sign-in page directly, with no Cloudflare Access login.
- Keep dashboard membership invite-only and enforce Netzar OS roles in the
  backend.
- Send invitation links, login links, and enabled agent email from
  `no-reply@pgnos.ai` through Amazon SES.
- Use Cloudflare for authoritative DNS, edge HTTPS, the application tunnel,
  DDoS protection, managed WAF protections, and login rate limiting.
- Keep AWS private: no new public task IP and no new public ALB ingress.
- Preserve the SSM dashboard tunnel as break-glass access.
- Make every AWS change through typed Netzar lifecycle commands and stop at the
  repository's cost and human gates.

## Non-goals

- Cloudflare Access, One-time PIN, WARP enrollment, or device restrictions.
- Granting dashboard access from AWS IAM membership. AWS users and Netzar OS
  users remain separate populations.
- Enabling Cloudflare Email Routing for inbound mail.
- Replacing the application's SES integration with Cloudflare Email Sending.
- Slack, Telegram, a public marketing site, or a deployment-mode change to
  `chat`.
- Any change to `salessly.io`, the `claudeclaw` tunnel, or unrelated Cloudflare
  resources.
- Destruction or replacement of the current production installation.

## Chosen architecture

### Public application path

A new remotely managed Cloudflare Tunnel named
`netzar-production-public` terminates at a `cloudflared` sidecar in the existing
production ECS task. The sidecar shares the task network namespace with the
Netzar OS container and forwards only the published hostname to
`http://localhost:3000`.

Cloudflare publishes `app.pgnos.ai` as a proxied tunnel hostname and terminates
browser TLS at the edge. The tunnel is outbound-only from the private ECS task;
the application task and internal ALB do not gain Internet ingress. The tunnel
configuration ends with an explicit `http_status:404` catch-all.

The connector image is pinned to an immutable, ARM64-compatible digest. Its
token is stored as a JSON field in a retained, KMS-encrypted Secrets Manager
secret and injected with an ECS secret reference. It must never be accepted as
a command-line argument, printed, stored in `.env`, returned by an envelope, or
written to Git.

The connected Cloudflare API creates and configures only the new tunnel,
`app.pgnos.ai` route, and named security rules. The local Netzar setup command
transfers the connector token directly to Secrets Manager without displaying
it.

### Authentication and membership

Cloudflare Access is deliberately absent. An unauthenticated browser reaches
the Netzar OS login page and no protected dashboard data.

Netzar OS remains the authentication and authorization boundary:

- The existing `DASHBOARD_TOKEN` is the initial and break-glass owner login.
- Users are created only through an invitation from an authorized Netzar OS
  member; there is no public self-signup.
- Invitation links are single-use and expire after 72 hours.
- Login links are single-use and expire after 15 minutes.
- Active users resolve to the existing viewer, analyst, operator, admin, or
  owner capability profile. The backend remains authoritative.
- AWS IAM users receive no automatic dashboard access.

The public login request continues returning the same response for known and
unknown addresses so the endpoint does not reveal membership. Cloudflare adds
a conservative rate limit to the login request path, while the application
retains its existing send cap and audit records.

### Email path

Amazon SES in `us-east-1` remains the application mail provider because the
repository already implements and authorizes that path. Cloudflare is the DNS
control plane, not the message sender.

The configuration is:

```text
CCE_DASHBOARD_URL=https://app.pgnos.ai
CCE_EMAIL_FROM=no-reply@pgnos.ai
```

A typed, idempotent Netzar email setup lifecycle creates or discovers the SES
domain identity for `pgnos.ai`, configures a custom MAIL FROM subdomain, and
returns only the public DNS validation records. The connected Cloudflare API
writes those records into the `pgnos.ai` zone. The expected record groups are:

- SES Easy DKIM CNAME records;
- a custom MAIL FROM MX record under `bounce.pgnos.ai`;
- an SPF TXT record under `bounce.pgnos.ai`;
- a DMARC TXT record at `_dmarc.pgnos.ai`, starting in monitoring mode.

The setup command verifies DKIM and MAIL FROM status without exposing secret
material. If SES production access is not enabled, it emits the exact AWS human
gate instead of claiming success. Production access is required before invites
can be sent to arbitrary client addresses.

Only after the SES identity is verified and production access is confirmed does
the lifecycle deploy `CCE_EMAIL_FROM` and `CCE_DASHBOARD_URL` into the task. The
existing `email_send_disabled` kill switch and application send limits continue
to apply.

Cloudflare Email Routing remains disabled because it handles incoming mail and
is not needed for dashboard sign-in or agent email.

### Always-on behavior

Normal production state is at least one desired and one running ECS task. The
public-tunnel feature adds a CloudWatch alarm when the service falls below one
running task or the essential connector becomes unhealthy. The alarm uses the
existing operations alert path.

No scheduled or idle production pause is enabled. The PowerSwitch remains an
owner-only emergency and maintenance control. A deliberate maintenance pause
may temporarily mute the always-on alarm, but resuming must restore a desired
count of at least one and pass verification.

The deployment does not add a second Fargate service. The connector runs as a
small sidecar in the existing task.

## Components and boundaries

1. **Public-access configuration resolver** validates the feature flag, exact
   `app.pgnos.ai` hostname, `infra-only` mode, and absence of conflicting public
   domain settings. It contains no AWS or Cloudflare calls.
2. **Secret-safe Cloudflare setup lifecycle** verifies AWS account
   `239887088812`, discovers the exact new tunnel, and moves its connector token
   directly into Secrets Manager.
3. **ECS/CDK integration** adds the encrypted secret, essential connector
   sidecar, readiness probe, logs, and always-on alarm only when enabled.
4. **Cloudflare resources** contain the dedicated tunnel, published hostname,
   DNS record, managed edge protections, and login rate limit for `pgnos.ai`
   only.
5. **SES setup lifecycle** owns SES identity discovery/creation, typed public
   DNS output, production-access checks, and verification status.
6. **Existing Netzar authentication and email modules** remain the sole owner of
   invitations, magic links, sessions, roles, and message delivery.

Each component is independently testable and feature-gated. With the new public
feature disabled, synthesis and deployment reproduce the existing infra-only
shape.

## Data flow

### Browser request

1. A user opens `https://app.pgnos.ai`.
2. Cloudflare terminates TLS, applies edge security and rate limits, and sends
   the request through `netzar-production-public`.
3. The ECS `cloudflared` sidecar forwards the request to the Netzar container on
   task-local port 3000.
4. Netzar OS returns the login page or validates the existing bearer/session
   credential before returning protected data.

### Invitation or login email

1. An authorized member invites a user, or an active user requests a login
   link.
2. Netzar OS creates a single-use, TTL-bounded token and builds the absolute URL
   from `CCE_DASHBOARD_URL`.
3. SES sends from `no-reply@pgnos.ai`; DKIM, SPF, and DMARC authenticate through
   the Cloudflare-hosted DNS records.
4. The recipient follows the link to `app.pgnos.ai`; Netzar consumes the token
   once and creates the existing role-bound session.

## Failure handling

- **Expired AWS session:** stop before mutation and instruct the operator to run
  the browser-based `aws login --profile netzer-root`; then verify the account
  is exactly `239887088812`.
- **Tunnel or secret missing:** deploy may create the retained secret foundation
  and stop with the typed public-tunnel setup remediation. Rerunning is
  idempotent.
- **Tunnel unhealthy:** ECS marks the essential sidecar unhealthy, CloudWatch
  alerts, and the SSM dashboard tunnel remains the break-glass route.
- **SES identity pending:** no public email send is claimed; poll the typed
  verification check after DNS propagation.
- **SES sandbox:** surface the production-access human gate. Do not weaken the
  invite-only model or ask users to verify their own recipient addresses.
- **Email send failure:** preserve the existing fail-soft, constant-response
  login behavior and record the reason without logging tokens or addresses
  unnecessarily.
- **Cost gate:** run the Netzar lifecycle without `--yes`; stop and report the
  exact typed estimate before accepting any new cost.

## Deployment order

1. Finish implementation on an isolated feature branch based on the current
   `development` branch; do not merge the incomplete WARP branch into this work.
2. Run focused tests, full tests, type checks, builds, secret scan, and both
   feature-off and feature-on syntheses without AWS credentials.
3. Refresh temporary `netzer-root` authentication and prove AWS account
   `239887088812` before any AWS mutation.
4. Run the Netzar deployment lifecycle without `--yes` and obey its typed cost
   or remediation envelope.
5. Create the dedicated remote Cloudflare tunnel and copy its token through the
   secret-safe Netzar setup lifecycle.
6. Rerun the lifecycle to deploy the connector and always-on alarm.
7. Publish only `app.pgnos.ai` and the named Cloudflare edge rules.
8. Run the typed SES setup lifecycle, add its public DNS records through the
   Cloudflare API, and wait for SES verification and production access.
9. Deploy the two non-secret email environment values, run `npm run doctor`,
   then run `npm run verify`.
10. Test the initial owner login, invite one approved user, deliver and consume
    one login link, verify role enforcement, and prove the SSM fallback.
11. Merge through `development` and the established QA/staging/production
    promotion protocol only after checks and review are green.

## Verification criteria

- `https://app.pgnos.ai` presents the Netzar OS login page from an ordinary
  browser without Cloudflare Access or WARP.
- An unauthenticated request cannot read protected dashboard APIs.
- The ECS service has desired and running counts of at least one.
- The deployed task contains one essential, healthy, digest-pinned
  `cloudflared` sidecar with a Secrets Manager reference rather than a literal
  token.
- Cloudflare reports the new tunnel healthy and the published hostname targets
  only that tunnel.
- No `salessly.io` resource changed.
- SES reports the `pgnos.ai` identity and DKIM as verified and production access
  as enabled.
- A new invitation arrives from `no-reply@pgnos.ai`, its link points to
  `https://app.pgnos.ai`, works once, and grants only the assigned role.
- A login request for an uninvited address reveals nothing and sends nothing.
- `npm run doctor` and `npm run verify` are green.
- `npm run dashboard:tunnel` still provides break-glass access.

## Rollback

Before removing the public route, prove `npm run dashboard:tunnel` works. Then:

1. Disable the public-tunnel feature in configuration.
2. Run the normal Netzar deployment lifecycle and verify the sidecar and public
   tunnel dependency are absent from the task.
3. Remove only the `app.pgnos.ai` published route and
   `netzar-production-public` tunnel.
4. Leave the retained connector secret and SES identity in place until a later
   reviewed cleanup, or disable application email by clearing its two non-secret
   environment values through the normal configuration workflow.

Never run `npm run destroy`. Never delete or modify the existing `claudeclaw`
tunnel or any `salessly.io` resource.

## Cost and operational impact

The sidecar shares the existing production task; there is no second Fargate
service or public load balancer requirement. SES is metered per message and
Cloudflare features depend on the account's active plan. The implementation
must update the repository's typed cost estimate and stop at the exact cost gate
before production deployment. The previously approved monthly budget does not
authorize bypassing that gate.
