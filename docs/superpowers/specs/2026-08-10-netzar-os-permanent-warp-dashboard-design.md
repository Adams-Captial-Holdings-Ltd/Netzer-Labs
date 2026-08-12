# Netzar OS Permanent Private Dashboard Access Design

**Status:** Approved architecture; pending implementation
**Date:** 2026-08-10

## Context

The production installation is an `infra-only` deployment whose dashboard is
behind an internal AWS Application Load Balancer. The supported
`npm run dashboard:tunnel` path is secure, but it depends on a local SSM
session. It stops when the AWS session expires, the computer sleeps, or the
terminal exits.

The connected Cloudflare account has one existing tunnel named `claudeclaw`.
It is down and all of its application hostnames use `salessly.io`. That tunnel,
its DNS routes, and the `salessly.io` zone are explicitly outside this design.

## Goals

- Keep the PGN Consulting dashboard reachable from authorized devices without
  relying on a particular computer or AWS CLI session.
- Keep the dashboard private, identity-gated, and protected by MFA/device
  enrollment.
- Use no `salessly.io` hostname and create no anonymous public route.
- Preserve the existing SSM tunnel as a break-glass access path.
- Integrate through the Netzar lifecycle; never invoke bare `cdk deploy`.

## Non-goals

- A browser-only public hostname before PGN/Netzar owns a dedicated domain.
- Replacing the dashboard's capability token or AWS security controls.
- Reusing, deleting, or changing the existing `claudeclaw` Cloudflare tunnel.
- Copying client data, credentials, or dashboard tokens into Cloudflare.

## Selected architecture

### AWS connector

Create a separate, remotely managed Cloudflare Tunnel named
`netzar-production-private`. Run its `cloudflared` connector as a sidecar in
the existing production ECS task. ECS therefore starts and restarts the
connector with the dashboard and does not depend on a local computer.

The tunnel token is stored only in AWS Secrets Manager and injected into the
sidecar as an ECS secret. It must not appear in `.env`, GitHub, CDK output,
logs, manifests, or command output. The connector gets only the network access
needed to reach the internal dashboard path.

Production retains a service floor of one running task. Automatic idle
scale-to-zero is disabled for production; the existing PowerSwitch remains a
manual emergency control. Connector health is part of ECS task health so a
failed connector cannot remain silently down.

### Stable private name

Create an AWS Route 53 private hosted zone and alias
`dashboard.pgn.internal` to the existing internal ALB. Configure a Cloudflare
private-hostname route for that name through `netzar-production-private`.
The name is not published in public DNS and is not based on `salessly.io`.

Authorized devices use:

`http://dashboard.pgn.internal/dashboard`

HTTP is acceptable only inside this design's encrypted WARP-to-Tunnel private
overlay and VPC hop, matching the narrow transport exception already used for
the SSM tunnel. The dashboard capability token remains mandatory. No direct
public HTTP listener is created.

### Identity and device access

Users install the Cloudflare One Client and enroll the device in the existing
Zero Trust organization. Enrollment is restricted to explicitly approved
identities and MFA. Gateway policies allow only enrolled identities and
managed devices to reach `dashboard.pgn.internal`; all other private routes
remain denied. Device removal revokes access without changing AWS credentials.

The existing Zero Trust team enrollment domain is not changed in this work,
because renaming it could affect unrelated applications. It is not used as the
dashboard hostname. A later, separately approved cutover can add a dedicated
PGN/Netzar public domain and a browser-only Cloudflare Access application.

## Data flow

1. An enrolled device resolves and opens `dashboard.pgn.internal` through the
   Cloudflare One Client.
2. Cloudflare evaluates device enrollment, identity, MFA, and Gateway policy.
3. Allowed traffic crosses the encrypted WARP and Cloudflare Tunnel path to
   the `cloudflared` sidecar in the production VPC.
4. The connector reaches the existing internal ALB; the ALB forwards to the
   dashboard container.
5. The dashboard independently validates its existing capability token.

Cloudflare receives network and identity metadata needed to enforce access,
but no knowledge-base content, Bedrock prompts, AWS keys, or dashboard token.

## Failure handling and observability

- ECS restarts an unhealthy task when the connector exits or fails health
  checks.
- Deployment verification checks that the ECS service is steady, the new
  Cloudflare tunnel is healthy, the private name resolves on an enrolled
  device, and the public Internet cannot reach the dashboard.
- CloudWatch alerts when the production running-task count drops below one.
- Cloudflare tunnel state is checked without printing connector credentials.
- If WARP is unavailable, operators use `npm run dashboard:tunnel` after
  short-lived AWS authentication.

## Deployment and rollback

Implementation is feature-flagged and defaults off for other clients. Each
client creates its own tunnel and AWS secret in its own accounts; no connector
credential is shared between clients.

Before any AWS mutation, verify the temporary `netzer-root` identity is account
`239887088812`. Apply AWS changes only through the Netzar lifecycle command and
stop at any typed cost or human gate. Cloudflare changes are scoped to the new
tunnel, private-hostname route, and access policies.

Rollback first proves the SSM tunnel works, then disables the feature flag and
redeploys through the lifecycle. It removes only the new private hostname,
route, secret, and tunnel. It never calls `npm run destroy` and never alters
the existing `claudeclaw` tunnel or `salessly.io` records.

## Testing and acceptance

- Unit tests prove the sidecar, secret reference, private DNS, and least-
  privilege rules appear only when the feature flag is enabled.
- Synth and log tests prove no Cloudflare token can appear in generated
  artifacts or output.
- Lifecycle tests prove deployment and rollback use `npm run deploy`, not a
  direct CDK command.
- An enrolled device can open the dashboard after local and AWS CLI sessions
  are closed.
- An unenrolled device and the public Internet cannot resolve or reach the
  private dashboard.
- Restarting/replacing the ECS task restores the connector automatically.
- The dashboard still requires its existing capability token.

## References

- [Cloudflare: create a remotely managed tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)
- [Cloudflare: connect a private hostname](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/private-net/cloudflared/connect-private-hostname/)
- [Cloudflare: connect an IP/CIDR with the Cloudflare One Client](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/private-net/cloudflared/connect-cidr/)
