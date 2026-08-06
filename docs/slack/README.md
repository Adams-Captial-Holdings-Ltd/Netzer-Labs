# Slack adapter setup

There are two ways to connect Slack. The dashboard flow is the one you want for
normal use. The manual flow at the bottom is the legacy single-app path kept for
break-glass and reference.

## Recommended: connect from the dashboard (per-agent)

Each agent can own its own Slack app, so the connect flow lives on the agent
page and needs no AWS CLI and no redeploy.

1. Open the agent in the dashboard and go to the **Connections** tab.
2. Under **Connect Slack App**, click **Copy** on the app manifest. It is
   generated for this agent with the correct event URL already filled in
   (`https://<your-domain>/slack/<agent>/events`).
3. Open https://api.slack.com/apps, click **Create New App**, then **From a
   manifest**. Pick your workspace and paste the manifest.
4. Open **Install App** and **Install to Workspace**.
5. Copy the **Bot User OAuth Token** (`xoxb-…`) from the Install App page and
   the **Signing Secret** from **Basic Information → App Credentials**.
6. Paste both back into the dashboard, click **Validate Token**, then **Connect
   App**.

The token and signing secret are stored on the agent's record and read live
(60s cache), so the agent starts answering immediately with no task rollout.

### Why the manifest "just works"

Slack pings the events URL with a one-time `url_verification` challenge the
moment you create the app. The per-agent events route answers that handshake
before it requires credentials or a signature, so app creation succeeds even
though you have not pasted a token yet. Real events after setup still require
the stored signing secret and a valid Slack signature.

Interactivity is intentionally left out of the generated manifest because the
per-agent adapter only serves `/slack/<agent>/events`. Re-add it (and a handler)
when per-agent Block Kit callbacks land.

## Routes

ClaudeClaw exposes Slack endpoints on the ALB:

| Route                       | Purpose                                          |
| --------------------------- | ------------------------------------------------ |
| `POST /slack/<agent>/events`| Per-agent Events API (app_mention, message.im)   |
| `POST /slack/events`        | Legacy single-app Events API                     |
| `POST /slack/commands`      | Legacy single-app slash commands                 |
| `POST /slack/interactive`   | Legacy single-app Block Kit callbacks            |

All verify Slack's `X-Slack-Signature` HMAC against the relevant signing secret
over a 5-minute timestamp window.

## Agent routing

- `@<bot>` mention routes to that agent's Slack app directly.
- DMs default to the agent and stay sticky until a new agent is picked.
- Thread replies inherit the parent message's agent.

## Persona overrides

Each agent posts with a distinct `username` + `icon_url` on every channel post
(scope `chat:write.customize`). DMs strip overrides and use the default
ClaudeClaw identity.

## Legacy: single global Slack app (manual)

This is the original path. Use it only if you want one app shared across the
whole deployment instead of per-agent apps.

1. Open https://api.slack.com/apps → **Create New App** → **From an app
   manifest**.
2. Paste the JSON in `app-manifest.json`, replacing `REPLACE_WITH_YOUR_DOMAIN`
   with your ALB domain.
3. Install the app and copy the **Bot User OAuth Token** (`xoxb-…`) and the
   **Signing Secret**.
4. Update the SecretsManager secret created by the CDK Secrets stack:
   ```bash
   aws secretsmanager put-secret-value \
     --secret-id /claudeclaw/slack \
     --secret-string '{"bot_token":"xoxb-…","signing_secret":"…"}'
   ```
5. Force a new task rollout so the container picks up the secret:
   ```bash
   aws ecs update-service \
     --cluster claudeclaw-cluster \
     --service claudeclaw-service \
     --force-new-deployment
   ```

## Verifying the wiring

After connect:
```bash
curl -X POST https://your-domain/slack/<agent>/events \
  -H "Content-Type: application/json" \
  -d '{"type":"url_verification","challenge":"abc"}'
# → 200 {"challenge":"abc"}, the handshake is answered unauthenticated.
# A real event_callback without a valid signature returns 401.
```
