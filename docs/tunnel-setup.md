# Cloudflare Tunnel Setup

Expose the Netzar OS Enterprise dashboard via Cloudflare Tunnel to add a zero-trust, SSO-gated access layer in front of it. Note: this does not close the ALB — in the default (chat) deploy the ALB is internet-facing and its security group admits `0.0.0.0/0` on ports 80/443 (`infra/lib/network-stack.ts`). For a genuinely private origin, use `infra-only` mode with no domain set (that combination provisions an internal ALB) or lock down the ALB security group.

## Prerequisites

- `cloudflared` installed (`brew install cloudflared` on macOS)
- Cloudflare account with a domain
- ALB DNS name from the CDK deploy output

## Setup

### 1. Authenticate

```bash
cloudflared tunnel login
```

### 2. Create tunnel

```bash
cloudflared tunnel create claudeclaw
```

Note the tunnel ID printed (e.g., `a1b2c3d4-...`).

### 3. Configure

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL_ID>
credentials-file: ~/.cloudflared/<TUNNEL_ID>.json

ingress:
  # Dashboard (Preact SPA + API)
  - hostname: dashboard.yourdomain.com
    service: http://<ALB_DNS_NAME>:80
    # (no originRequest.noTLSVerify here: it only affects https:// origins;
    #  with an http:// origin there is no TLS handshake, so it is a no-op)
  # Catch-all
  - service: http_status:404
```

Replace `<TUNNEL_ID>` and `<ALB_DNS_NAME>` with your values.

### 4. DNS routing

```bash
cloudflared tunnel route dns claudeclaw dashboard.yourdomain.com
```

This creates a CNAME record pointing to your tunnel.

### 5. Add Cloudflare Access policy (optional but recommended)

In the Cloudflare Zero Trust dashboard:
1. Go to Access > Applications > Add an application
2. Type: Self-hosted, domain: `dashboard.yourdomain.com`
3. Add a policy: allow by email (e.g., `you@gmail.com`)
4. This adds SSO-level auth on top of the bearer token

### 6. Run as service

```bash
# macOS
sudo cloudflared service install

# Linux
sudo cloudflared --config ~/.cloudflared/config.yml service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
```

## What gets tunneled

| Path | Purpose |
|------|---------|
| `/dashboard` | Preact SPA (login, agent management) |
| `/dashboard/agents/*` | Agent detail pages (SPA routing) |
| `/api/*` | Dashboard JSON API (bearer-token gated) |
| `/dashboard/warroom` | War room page |

## What stays on the public ALB

Telegram and Slack webhooks must be reachable by their respective platform servers:

| Path | Purpose |
|------|---------|
| `/tg/:agentId/webhook` | Telegram bot webhooks |
| `/slack/events` | Slack Events API |
| `/slack/:agentId/events` | Per-agent Slack events |

These are authenticated by their own signature verification mechanisms (Telegram secret token header, Slack HMAC signing).

## Troubleshooting

```bash
# Test tunnel locally before installing as service
cloudflared tunnel run claudeclaw

# Check tunnel status
cloudflared tunnel info claudeclaw

# Livestream tunnel logs (there is no `cloudflared tunnel log` subcommand)
cloudflared tail claudeclaw
```
