# Runbooks

One file per recurring operational task. Each runbook is structured the same way:

1. **Symptom** — what you see that suggests you need this runbook
2. **Verify** — quick command to confirm
3. **Fix** — copy-pasteable commands
4. **Rollback** — how to undo if the fix misbehaves
5. **Why this happened** — root cause + how to prevent recurrence

Every command in here has been run at least once. If you find one that's wrong, fix it in place — runbooks rot the moment they stop matching reality.

## Index

| Runbook | When you need it |
|---|---|
| [deploy-validation.md](deploy-validation.md) | Verify a deploy didn't ship a broken task definition (the `/health` 200 isn't enough) |
| [rotate-dashboard-token.md](rotate-dashboard-token.md) | Dashboard bearer token leaked or due for quarterly rotation |
| [rotate-cf-origin-secret.md](rotate-cf-origin-secret.md) | The `X-CloudFront-Origin` secret needs rotation (or has leaked) |
| [rotate-config-secrets.md](rotate-config-secrets.md) | OAuth, Slack signing and MCP secrets exposed by `/api/config` before NZR-43 |
| [restore-from-ddb-export.md](restore-from-ddb-export.md) | A DynamoDB table needs a point-in-time restore |
| [kill-switches.md](kill-switches.md) | You need to trip or disarm one of the 40 kill switches |
| [force-cf-invalidation.md](force-cf-invalidation.md) | A stale asset is being served by CloudFront edge cache |
| [debug-no-slack-response.md](debug-no-slack-response.md) | The Slack bot stopped replying to DMs |
| [debug-no-telegram-response.md](debug-no-telegram-response.md) | The Telegram bot stopped replying |
| [scale-up-for-traffic-burst.md](scale-up-for-traffic-burst.md) | Real or expected load spike; pre-scale Fargate before the WAF rate-limit trips |
| [rollback-bad-image.md](rollback-bad-image.md) | A deploy shipped a broken image (the ARM64 / Bedrock-env class of bugs) |

## Conventions

- Commands assume macOS + zsh + `aws` CLI v2 + `gh` CLI configured. Linux works the same after dropping `-j -f` flags from `date`.
- `<placeholder>` means substitute your value; the runbook doesn't make assumptions about what it is.
- Anything that touches production has an explicit verify step before AND after.
- Phone-friendly: each runbook fits on one screen of an iPhone reader so you can run it from a call.
