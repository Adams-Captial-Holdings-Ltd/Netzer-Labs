# Give your agents tools with MCP

Your agents can call tools on any [Model Context Protocol](https://modelcontextprotocol.io)
server: post to Slack, file a Jira issue, read a CRM record, hit an internal
API. The orchestrator is an MCP **client** — it pulls each server's tool list
into every agent turn and dispatches the model's tool calls back to the server.
Once a server is connected, its tools work from every surface: Telegram, Slack,
and the dashboard chat. So "check my Slack DMs" from your phone just works.

There are two ways to connect a server, and they compose:

| Path | Use it for | Auth | Where credentials live |
|------|-----------|------|------------------------|
| **A. Amazon Bedrock AgentCore Gateway** | Your own APIs/Lambdas, OpenAPI specs, and the SaaS providers AWS ships gateway templates for (Salesforce, Jira, Zendesk, ServiceNow…). The AWS-native path. | SigV4 with the task's IAM role — **no stored secrets** | AWS (token vault / IAM) |
| **B. A vendor's hosted remote MCP** | Vendors that run their own MCP endpoint (Slack at `mcp.slack.com`, Atlassian Rovo, Notion, Linear…). Fastest one-vendor setup. | OAuth bearer token | Your runtime-config table (encrypted at rest) |

Either way, the orchestrator change is zero — you add a server in the
Integrations tab (or via the API) and its tools are live within seconds. No
redeploy.

> **Region note.** AgentCore is available in a subset of AWS regions. These
> instructions assume `us-east-1` (the default for this stack). Adjust the
> region in URLs and CLI commands if you run elsewhere.

---

## How it works

```
agent turn ──► orchestrator (MCP client) ──► MCP server ──► the real API
   ▲                  │  src/lib/mcp/                            │
   └──── answer ◄─────┴───────── tool result ◄───────────────────┘
```

- **Registry:** `src/lib/mcp/servers-repo.ts` — servers are one JSON value in
  the `runtime-config` table (`category: mcp`, `key: servers`). Reads are cached
  ~30s and invalidated on write, so an edit reaches all tasks in seconds.
- **Client:** `src/lib/mcp/client.ts` — Streamable-HTTP JSON-RPC with three auth
  modes: `iam` (SigV4, service `bedrock-agentcore`), `bearer`, `none`.
- **Tool merge + dispatch:** `src/lib/mcp/mcp-tools.ts` — namespaces every tool
  `mcp__<serverId>__<tool>` so it can't shadow a built-in, caches tool lists 5
  minutes, and **fails soft** (an unreachable server costs its tools for one
  cache window, never the turn). MCP calls ride the existing `tool_use` kill
  switch and emit the same tool metrics as built-ins.
- **Surface:** the **Integrations** tab → *Agent tool servers* section
  (list / add / enable / remove + a live **Test tools** probe). Writes are
  admin-gated and audited as `mcp_servers_updated`. Bearer tokens are
  write-only — the API only ever reports `hasBearerToken: true`.

---

## Path A — Amazon Bedrock AgentCore Gateway (AWS-native)

A gateway is a managed MCP endpoint that fronts one or more **targets** (a
Lambda, an OpenAPI/Smithy spec, or a pre-built SaaS integration). With
`AWS_IAM` inbound auth, the ECS task role signs its own requests — nothing to
store or rotate.

### 1. Create the gateway

```bash
# Service role the gateway assumes to invoke your targets
aws iam create-role --role-name MyGateway-ServiceRole \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"bedrock-agentcore.amazonaws.com"},"Action":"sts:AssumeRole","Condition":{"StringEquals":{"aws:SourceAccount":"<ACCOUNT_ID>"},"ArnLike":{"aws:SourceArn":"arn:aws:bedrock-agentcore:us-east-1:<ACCOUNT_ID>:*"}}}]}'

aws bedrock-agentcore-control create-gateway --region us-east-1 \
  --name my-gateway \
  --role-arn arn:aws:iam::<ACCOUNT_ID>:role/MyGateway-ServiceRole \
  --protocol-type MCP \
  --authorizer-type AWS_IAM \
  --query '{id:gatewayId,url:gatewayUrl,status:status}'
```

The returned `gatewayUrl` looks like
`https://<gateway-id>.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp`.
Wait until `get-gateway` reports `READY`.

### 2. Add a target

Easiest target to prove the pipeline is a Lambda. Give the gateway role
`lambda:InvokeFunction` on it, then:

```bash
aws bedrock-agentcore-control create-gateway-target --region us-east-1 \
  --gateway-identifier <gateway-id> \
  --name my-tools \
  --target-configuration file://target.json \
  --credential-provider-configurations '[{"credentialProviderType":"GATEWAY_IAM_ROLE"}]'
```

`target.json` holds the tool schema (`mcp.lambda.toolSchema.inlinePayload[]`,
each entry a `name` / `description` / JSON-Schema `inputSchema`). For SaaS
providers, use the **Integrations** target type and pick the provider in the
[create-gateway console wizard](https://us-east-1.console.aws.amazon.com/bedrock-agentcore/toolsAndGateways/createwizard?region=us-east-1)
instead — that path attaches the provider's OAuth client for you.

> AgentCore embeds the target name in tool names, e.g.
> `my-tools___get_weather`. That's expected.

### 3. Let the task role invoke the gateway

Grant the orchestrator task role `bedrock-agentcore:InvokeGateway` on just this
gateway, as a **standalone managed policy** so revoking is a one-line detach
(the same pattern this repo uses for the IAM-copilot and Playground grants):

```bash
aws iam create-policy --policy-name MyGatewayInvoke \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"bedrock-agentcore:InvokeGateway","Resource":"arn:aws:bedrock-agentcore:us-east-1:<ACCOUNT_ID>:gateway/<gateway-id>"}]}'

aws iam attach-role-policy --role-name <ORCHESTRATOR_TASK_ROLE> \
  --policy-arn arn:aws:iam::<ACCOUNT_ID>:policy/MyGatewayInvoke
```

> These resources are created out-of-band on purpose — **no `cdk deploy`** — so
> arming a gateway never risks unrelated stack drift (e.g. the daily cost-cap).

Now skip to [Connect it in the dashboard](#connect-it-in-the-dashboard) with
auth mode **AWS IAM**.

---

## Path B — a vendor's hosted remote MCP (Slack walkthrough)

Slack runs an official MCP server at `https://mcp.slack.com/mcp`. The pattern
generalizes to any vendor that publishes
`/.well-known/oauth-protected-resource` (Atlassian, Notion, Linear, …): read
their scope list, register an app, OAuth in, paste the token.

> **Do this in your own browser, signed in to your workspace.** An assistant
> should never click the vendor's final "Allow" or type your token. The steps
> below are the ones a human runs.

### 1. Create a Slack app

1. Go to <https://api.slack.com/apps> → **Create New App** → **From a manifest**.
2. Pick your workspace and paste a minimal manifest. Request **user** scopes for
   what you want the agent to do. A good starting set:

   ```json
   {
     "display_information": { "name": "CCE MCP Bridge" },
     "oauth_config": {
       "redirect_urls": ["https://<your-domain>/dashboard/"],
       "scopes": {
         "user": [
           "search:read.public", "search:read.private",
           "search:read.im", "search:read.mpim", "search:read.users",
           "channels:history", "groups:history", "im:history", "mpim:history",
           "users:read", "chat:write"
         ]
       }
     },
     "settings": { "org_deploy_enabled": false, "socket_mode_enabled": false, "token_rotation_enabled": false }
   }
   ```

   The `search:read.im` / `im:history` family is what lets the agent read your
   **DMs**; `search:read.users` enables **name lookups**. Public-only scopes
   leave the agent unable to see DMs — that's a scope choice, not a product
   limit.

3. **Enable MCP on the app.** In the app's **Features → Agents & AI Apps**
   settings, turn on **Model Context Protocol** (there is no toggle labeled
   "Slack MCP Server"). This is **off by default** and the endpoint refuses
   connections until it's on — the error reads
   `App is not enabled for Slack MCP server access`.

### 2. Authorize (OAuth 2.0 + PKCE)

Slack uses the user-token flow with PKCE. Build the authorize URL with your
`client_id`, the scopes above, your redirect URL, and a PKCE
`code_challenge` (S256). Slack's endpoints (from its discovery doc):

- authorize: `https://slack.com/oauth/v2_user/authorize`
- token: `https://slack.com/api/oauth.v2.user.access`

Generate the PKCE pair and the authorize URL (standard OAuth 2.0 authorization-code flow with PKCE, S256):

```python
import base64, hashlib, secrets, urllib.parse
verifier  = base64.urlsafe_b64encode(secrets.token_bytes(48)).rstrip(b'=').decode()
challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
params = {
  "response_type": "code", "client_id": "<CLIENT_ID>",
  "scope": "search:read.public search:read.im search:read.users users:read chat:write im:history channels:history",
  "redirect_uri": "https://<your-domain>/dashboard/",
  "state": secrets.token_urlsafe(16),
  "code_challenge": challenge, "code_challenge_method": "S256",
}
print("https://slack.com/oauth/v2_user/authorize?" + urllib.parse.urlencode(params))
print("verifier:", verifier)  # keep for the exchange
```

Open the URL, click **Allow**, copy the `code` from the redirect, then exchange:

```bash
curl -s -X POST https://slack.com/api/oauth.v2.user.access \
  -d client_id=<CLIENT_ID> -d client_secret=<CLIENT_SECRET> \
  -d code=<CODE_FROM_REDIRECT> \
  -d redirect_uri=https://<your-domain>/dashboard/ \
  -d code_verifier=<VERIFIER>
# -> { "ok": true, "access_token": "xoxp-…", "scope": "…" }
```

The result is a non-expiring `xoxp-…` user token. To add a scope later (e.g.
`search:read.users` for name lookups), just re-run this flow with the extra
scope and re-paste the new token — no app recreation needed.

### 3. Connect it in the dashboard

Same as Path A — see below — with auth mode **Bearer token** and paste the
`xoxp-…` token.

---

## Connect it in the dashboard

1. Open **Integrations → Agent tool servers → Add server**.
2. Fill in:
   - **id** — short slug, e.g. `slack` or `aws-gateway`
   - **URL** — the MCP endpoint
   - **auth** — *AWS IAM* (gateways) or *Bearer token* (vendor) and paste the token
   - **agents** — leave empty for all agents, or scope to specific agent ids.
     A token that acts as *you* (like a Slack user token) should usually be
     scoped to a single trusted agent.
3. Save, then click **Test tools** — it does a live `tools/list` against the
   real endpoint and shows exactly what the agents will see, or the precise
   transport/auth error if something's off.

Prefer the API? `PUT /api/integrations/mcp` with
`{ "servers": [ { id, name, url, auth, bearerToken?, enabled, agents[] } ] }`
(admin token). Omit `bearerToken` on a later edit to keep the stored one.
`POST /api/integrations/mcp/<id>/probe` runs the live test.

---

## Help the agent use the tools well

Vendor tool descriptions are good but agents still benefit from a short recipe
in the agent's system prompt (`agents/<id>/CLAUDE.md` in the config bucket).
The pattern that worked for Slack:

- State plainly what the token *can* see (DMs, private channels) so the agent
  never invents a "missing permission" excuse.
- Give the one-call recipe for the common ask. For Slack DMs:
  `slack_search_public_and_private` with `query: "to:me"`, `sort: "timestamp"`.
- Name the traps: don't pass the owner's own user id as a target; the `from:`
  search modifier needs the `<@U…>` id form, not a plain name.
- Tell it to re-evaluate each turn, not echo an earlier "I can't."

Two robustness behaviors are built into the loop so a fumbled tool call doesn't
ruin a turn: the tool-dispatch budget is 8 rounds, and if the model exhausts it
mid-work the orchestrator makes one final no-tools call to force a worded answer
(never a blank `(no response)`).

---

## Security & revocation

- **Gateway (Path A):** credentials never leave AWS; the task role signs
  requests. Revoke by detaching the `…Invoke` managed policy, or delete the
  gateway.
- **Vendor token (Path B):** the token lives only in the `runtime-config` table
  (encrypted at rest) and is write-only over the API. Revoke by removing the
  server in the Integrations tab **and** deleting/uninstalling the vendor app.
- Scope tokens to the fewest agents that need them. A user token inherits *your*
  access — treat it like a password.
- All MCP tool calls honor the `tool_use` / `tool_dispatch_disabled` kill
  switches and emit the same CloudWatch (EMF) tool metrics as built-ins
  (`src/lib/mcp/mcp-tools.ts`). Individual MCP tool invocations are not written
  to the audit log; only MCP server registry changes are audited.

---

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `Test tools` shows an auth error on a gateway | Task role missing `bedrock-agentcore:InvokeGateway` on that gateway ARN, or wrong region in the URL. |
| Slack: `App is not enabled for Slack MCP server access` | Turn on **Slack MCP Server** under the app's Agents & AI Apps settings. |
| Slack: `missing_scopes` on a tool | The token's grant lacks that scope. Re-run OAuth with the scope added (e.g. `search:read.users` for name lookups) and re-paste the new token. |
| Agent says it "can't see DMs" | A recipe problem, not permissions — confirm the DM scopes are granted, then add the DM recipe to the agent's prompt. |
| Tools don't show up in a turn | Server `enabled: false`, agent not in the server's `agents[]`, or a stale 5-min tool cache — hit **Test tools** to refresh immediately. |
| A tool name looks mangled in logs | Expected — tools are namespaced `mcp__<server>__<tool>`; `humanizeToolName()` renders them for display. |
