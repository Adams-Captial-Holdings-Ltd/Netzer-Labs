# Setup answers templates (unattended install)

These files feed the noninteractive setup wizard so a whole install can run
without a single prompt:

```bash
npm run up -- --answers examples/answers/infra-only-t0.json --yes
# or just the wizard step:
npm run setup -- --answers examples/answers/infra-only-t0.json
```

| File | What you get | Standing cost |
|---|---|---|
| `infra-only-t0.json` | Cheapest real install. Dashboard only (reached via `npm run dashboard:tunnel`), no domain, no chat surfaces, no add-ons, $5/day Bedrock cap. The right first deploy for someone new to AWS. | ~$65-95/mo |
| `chat-telegram.json` | Telegram-first chat install. Needs a real domain you control and a bot token from @BotFather. Knowledge ingestion on. | ~$130-180/mo |
| `chat-slack.json` | Slack-first chat install. Needs a real domain you control plus a Slack app's bot token and signing secret ([docs/slack/README.md](../../docs/slack/README.md) has the app manifest). Knowledge ingestion on. | ~$130-180/mo |

Before running, edit the copy you use:

1. `awsRegion` if you are not in `us-east-1` (pick a Bedrock-supported region).
2. For `chat-telegram.json`: set `domainName` to a domain you control and
   `telegramToken` to the token @BotFather gave you. Setup validates the token
   live (`getMe`), so a placeholder fails fast with a clear message. For
   `chat-slack.json`: same `domainName` rule, plus `slackBotToken` and
   `slackSigningSecret` from your Slack app (validated live via `auth.test`).
   After deploy, one paste remains: the printed `/slack/events` URL into the
   app's Event Subscriptions page.
3. Optional add-ons and tiers: the full schema (every key, every default) is
   documented in [docs/runnable-blocks.md](../../docs/runnable-blocks.md) and
   enforced by `scripts/lib/setup-answers.ts`.

Secrets note: an answers file containing a real token is a credential at
rest. Keep your edited copy OUT of git (copy it somewhere like
`~/cce-answers.json` first); these templates ship with placeholders only.

Validation still runs in noninteractive mode: STS identity, a live Bedrock
`InvokeModel` probe, the Docker daemon check, and Slack/Telegram token checks
all execute exactly as they do interactively, and any failure is a hard exit
with the same remediation text the wizard would print.
