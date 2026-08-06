# Operator handover runbook (`npm run handover`)

> Plain English: when the person running this deployment changes, "give them
> the AWS login" is not a handover, because half the system's authority lives
> outside AWS in things like the Telegram bot, the Slack app, the domain
> registrar, and a GitHub PAT. `npm run handover` rotates everything it can
> reach, blocks until a human reissues everything it cannot, and then stamps
> a config epoch so the departing operator's stale laptop can never quietly
> take the deployment back. This document is the full flow, the credential
> classification table, and the traps.

This is the OPERATOR handover (same account, new human). Moving to a
different AWS account is a different procedure with different mechanics; see
the [account-migration runbook](account-migration.md) (plan item 48).

## When to use it

- The person who owns day-to-day operation changes (employee departure,
  team transfer, consultancy handing a deployment to the client).
- A credential-compromise drill where you want every operator-facing secret
  rotated and proof the new owner receives owner-only traffic.

Do NOT use it for routine token rotation; the dashboard has a
[token-rotation runbook](runbooks/rotate-dashboard-token.md) for that.

## The flow

```
npm run handover -- --dry-run     # read everything, mutate nothing
npm run handover                  # the real, locked, mutating run
npm run handover -- --answers=handover-answers.json   # non-interactive values
```

1. **Inventory (read-only).** Prints account/region/tier/mode, the deployed
   version from the manifest, the stack list, domain, feature flags, the six
   Secrets Manager paths, the state-bucket location, the WORM audit bucket as
   an intentional residual, and every out-of-band resource from
   [the catalog](out-of-band-catalog.json). Secret *population* is judged
   from `DescribeSecret` metadata only (created vs last-changed dates); the
   inventory never reads a secret value.
2. **Access-transfer checklist + API checks.** The checklist names the
   account-level authority no API can move for you (see the table below).
   Three of those ARE machine-checkable, so the command checks them live:
   the Route 53 hosted zone and the exact nameservers the registrar must
   keep pointing at, the SES identities and their verification status, and
   the SNS alert subscriptions with pending confirmations flagged.
3. **Credential classification + rotation.** Command-owned values are
   rotated on the spot. External values BLOCK the run until you supply the
   newly issued replacements and they verify live (Telegram `getMe`, Slack
   `auth.test`).
4. **Redeploy + owner-path verification.** Secrets inject at task start, so
   the command forces an ECS redeploy, then sends a real Telegram message to
   each NEW owner chat id with the NEW bot token. SNS email delivery cannot
   be machine-verified end to end, so that half is an explicit printed
   manual step, never a fake green check.
5. **Config epoch stamp.** Only after verification succeeds, the command
   writes `state/config-epoch.json` (epoch n+1, completion time, a hash of
   the new owner identity) to the state bucket, journals it under the held
   lifecycle lock, and writes `CCE_CONFIG_EPOCH` plus the new owner ids into
   the local `.env` on the machine that ran it (the incoming operator's).

The whole mutating phase runs under the lifecycle lock (operation
`handover`) with a heartbeat, the same lease machinery every other mutating
lifecycle command uses, and every step is journaled to
`deploys/<handoverId>/journal/` in the state bucket.

## The config-epoch mechanism

After handover, the AUTHORITATIVE config source is the AWS side (Secrets
Manager + the manifest + the stamped epoch), and that is enforced rather
than assumed. `npm run doctor` (and therefore deploy, which runs the same
preflight) has a `config-epoch` check that compares the local `.env`'s
`CCE_CONFIG_EPOCH` against `state/config-epoch.json`:

- match, or no epoch ever recorded: pass.
- mismatch or missing local value while an epoch IS recorded: **FAIL**.
  That `.env` predates the handover, which is exactly the departing
  operator's stale file, and deploying with it would silently re-point
  owner ids and secrets. The fix is to re-run `npm run setup` against the
  recorded state, which writes the current epoch.

The epoch is monotonic (every completed handover increments it) and the
stamp carries only a hash of the new owner identity, never raw chat ids.

## Credential classification

Split honestly by who can act, not by what sounds automatable.

| Credential | Class | What happens |
| --- | --- | --- |
| Dashboard bearer token | command-owned | new random value written via `PutSecretValue`, shown once |
| Dashboard PIN | command-owned | new random 6-digit PIN; only its sha256 hash is stored (`pin_hash`) |
| Emergency kill phrase | command-owned | new random phrase written to the dashboard secret |
| Access keys of IAM users tagged `app=claudeclaw` | command-owned | new key created, old keys deleted; new material shown once |
| Access keys of ANY other IAM user (human, SSO, untagged) | checklist only | never touched programmatically |
| Telegram bot token | external (blocking) | you reissue via @BotFather; verified live with `getMe` before completion |
| Slack bot token + signing secret | external (blocking) | you reissue the app credentials; the bot token is verified live with `auth.test`, the signing secret is format-checked locally (32-char hex) |
| CodeBuild GitHub PAT | external (checklist) | the incoming operator imports their own PAT (`aws codebuild import-source-credentials`) |
| Domain registrar access | external (checklist) | transferred at the registrar, outside AWS entirely |
| Vendor API keys (Tavily/Brave/Exa/Serper/Gemini) | external (checklist) | reissue under the new operator's vendor accounts, update the `vendor-keys` secret |

The command never claims to have rotated anything in the external class; it
prints the checklist and refuses to finish until the blocking items are
supplied and verified.

## Owner identity

- Re-point `CCE_OWNER_TELEGRAM_CHATS` and `CCE_OWNER_SLACK_USERS` to the
  incoming operator's ids, and `CCE_OPERATOR_TELEGRAM_CHAT_ID` for
  webhook-monitor alerts. The command prompts for these and writes them.
- Keep `CCE_OWNER_LABEL` UNCHANGED. The label aliases the owner ROLE, so the
  owner-aliased memory history stays attached to the role rather than the
  departing person.
- Update the SNS alert-email subscriptions (see the trap below).

## The traps

- **SNS pending confirmations.** Subscription confirmations are emailed to
  whoever subscribed. A subscription stuck in `PendingConfirmation` was
  requested by the OLD operator and its confirm link sits in THEIR inbox.
  Re-subscribe the new addresses and confirm from the NEW inbox, then send a
  test publish and confirm receipt before treating alerts as transferred.
- **Nameserver authority sits outside AWS.** The Route 53 hosted zone is not
  the authority; the registrar's NS records are, and the registrar account
  may have nothing to do with this AWS account. The command prints the exact
  nameservers the registrar must keep pointing at. Losing registrar access
  loses the domain, the ACM validation records, and eventually TLS renewal.
- **OIDC `sub` pinning.** If the GitHub repo changes org/owner, the IAM
  OIDC trust policy still pins the OLD `owner/repo` in its `sub` condition.
  CI deploys then break SILENTLY (the role assumption fails) until the trust
  condition and `CCE_GITHUB_OWNER`/`CCE_GITHUB_REPO` are updated together.
- **Secrets inject at task start.** Rotating a secret changes nothing for
  running tasks; that is why the forced ECS redeploy is a mandatory step,
  not an optimization.
- **The departing operator's laptop.** Their `.env` still holds working-shape
  values. The config epoch is what turns that from a quiet hazard into a
  loud doctor/deploy FAIL on their machine.

## What completion means

The run prints `HANDOVER COMPLETE` with the epoch number only after the
external gate passed, the redeploy was forced, and the incoming operator's
Telegram owner path verifiably delivered. Even then, two things remain
human: confirming the SNS alert subscription from the new inbox, and working
every unchecked access-transfer line (root/billing contacts, GitHub,
registrar). The handover is finished when those are done, not when the
command exits.
