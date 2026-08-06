# Connect any agent to Telegram or Slack

Every agent (built-in or one you just created) has a **Connections** tab on its
detail page with the full guided flow. Nothing here needs the AWS CLI or a
redeploy. Two ways to run it:

1. **Do it yourself** with the on-card steps (copy the Slack manifest with one
   click, paste the two values back).
2. **Have Claude do it** in your browser. Each card has a "copy a prompt for
   Claude" button that copies an agent-specific prompt you paste into Claude in
   Chrome. The prompt hands the OAuth install and the secret paste back to you,
   because an assistant should never type your tokens or grant OAuth.

The prompts below are the same text those buttons produce. Replace
`<agent>` with the agent id and `<your-domain>` with your dashboard host.

## Slack prompt

The Slack prompt embeds the agent's generated manifest. Grab the real manifest
from the agent's Connections tab ("View / re-copy manifest"), or from
`GET /api/agents/<agent>/slack/manifest?domain=<your-domain>`.

```
Set up a Slack app and connect it to my ClaudeClaw agent "<agent>". Work in my browser. Do NOT type my tokens into any field or click Slack's "Allow" yourself, hand those two steps to me.

1. Go to https://api.slack.com/apps then Create New App, then From a manifest. Pick my workspace.
2. Paste this exact manifest and create the app:

<paste the agent's manifest here>

3. Open Event Subscriptions. If the Request URL shows "Your URL didn't respond", click Retry until it reads Verified.
4. Open Install App, then Install to Workspace. I will click Allow, then copy the Bot User OAuth Token (starts with xoxb-) and the Signing Secret (Basic Information, App Credentials).
5. Take me to https://<your-domain>/dashboard/agents/<agent> , Connections tab , Connect Slack App. I paste both values; you click Validate Token then Connect App.
```

## Telegram prompt

```
Connect a Telegram bot to my ClaudeClaw agent "<agent>". Do NOT type my bot token into any field yourself, hand that step to me.

1. Open https://t.me/BotFather. Send /newbot and pick a name plus a username ending in "bot".
2. I copy the token BotFather replies with (looks like 123456:ABC-DEF...).
3. Take me to https://<your-domain>/dashboard/agents/<agent> , Connections tab , Connect Telegram Bot. I paste the token; you click Validate Token then Connect Bot. The webhook registers automatically.
```

## The manifest snippet

The per-agent Slack manifest is generated for you with the agent's event URL
already filled in. Its shape (for agent `<agent>` on `<your-domain>`):

```json
{
  "display_information": { "name": "<Agent Display Name>", "description": "ClaudeClaw agent", "background_color": "#0f1419" },
  "features": { "bot_user": { "display_name": "<Agent Display Name>", "always_online": true } },
  "oauth_config": { "scopes": { "bot": [
    "app_mentions:read", "channels:history", "groups:history", "im:history", "chat:write", "chat:write.customize", "files:read", "files:write"
  ] } },
  "settings": {
    "event_subscriptions": {
      "request_url": "https://<your-domain>/slack/<agent>/events",
      "bot_events": ["app_mention", "message.im"]
    },
    "org_deploy_enabled": false, "socket_mode_enabled": false, "token_rotation_enabled": false
  }
}
```

The `request_url` is the per-agent route. The events endpoint answers Slack's
one-time `url_verification` challenge before requiring credentials, so creating
the app from this manifest verifies on the first try (or after one Retry). Real
events afterwards still require the stored signing secret and a valid signature.
