# ADR 0011 — Regenerate is tied to the reply shown, the file note is a notice, and the chat lock has a lease

**Status:** Accepted (2026-09-28, owner decisions 65, 66 and 67; roadmap step 9, P7 hardening)

## Context

- Regenerate (P6) re-answers the conversation's STORED last exchange. With the chat open in two tabs, or after a
  stopped reply whose save failed, that is not the reply the page shows: the server replaced a reply the person never
  saw, and the page showed the new answer under an older question until a reload (A233). The server fenced its own
  read-to-save window on the stored message count, but nothing tied the request to what the page showed, and stored
  replies carried no id.
- A file-only send whose file the model cannot read is answered with a fixed note ("… stored but not read") saved as an
  ordinary reply. After a reload the page offered Regenerate on it; regenerating asked the model the question without
  the file and replaced the note (A241).
- Artifact saves and chat erasure (delete, forget-me, purge) serialise on a per-conversation child lock row that had no
  lease: a process that died holding it left the chat undeletable until an operator removed the row, and nothing
  alerted (the P4 security review's M3, carried by decision 59).

## Decision

1. **Decision 65.** Every saved assistant reply stores `requestId`, the `clientMessageId` of the request that produced
   it: `appendTurns` stamps it from the route's enrichment, and `replaceLastReply` writes the new reply's own id and
   never keeps the old one. The transcript returns it. The page sends `replyTo` — the `requestId` of the reply it shows,
   or `null` for a reply saved before this change — with a regenerate. The server refuses a mismatch with 409
   `reply_changed` before the turn record, any stored-file read or any model call, and logs agentId and chatId only; the
   page reloads the chat and says so in one sentence. A regenerate without the field (a tab opened before the change)
   keeps the old behaviour.
   The approval named a page-kept message count as the fallback for older replies; the same step replaced it with
   "a missing id counts as `null`" (Jev 0.98), which is exact after the deploy. The stored field is unchanged.
2. **Decision 66.** The file-only note is saved with `status: 'notice'`. The page shows a notice without Regenerate,
   and the server refuses to regenerate one (409 `nothing_to_regenerate`). Notes saved before the change stay
   regenerable. The same step extended the rule to the kill-phrase confirmation (the decision's revisit trigger, "another
   canned reply type is stored", fired in the security review, INFO-8; council 3-0): it is saved as a notice and reaches
   the page as a canned `reply` event, so it is never offered for Regenerate.
   Confirmations saved before the change stay regenerable, as older notes do.
3. **Decision 67.** Acquiring the child lock succeeds when no lock exists or the existing lock's `createdAt` is older
   than 15 minutes (`attribute_not_exists(PK) OR createdAt < :cutoff`, one conditional Put); a takeover writes a warn
   log with the old lock's age in seconds; a late release that finds another holder's token logs instead of throwing.
   No new stored field.

## Consequences

- Good: Regenerate cannot replace a reply the person is not looking at; the notice cannot be regenerated; a crashed
  holder no longer strands a chat — the first operation after 15 minutes recovers it, and the log shows it.
- Cost: one optional field on stored replies and one more `status` value; older readers ignore both. A regenerate from
  a tab that is behind now reloads instead of silently replacing a reply.
- Risk: a holder that runs longer than 15 minutes can race the new holder (saves and deletes take seconds to minutes).
  A false `reply_changed` would block Regenerate on a reply the page really shows.
- Reversibility: one-way in form for 65 and 66 (stored data), additive in effect; one-way for the lock semantics (67),
  with no data change.
- Revisit triggers: a false `reply_changed` in a test or on staging (65); another canned reply type is stored (66); a
  save or delete that runs longer than 15 minutes, or any takeover log line on staging (67).

## Alternatives considered

- Tie by a message count (no stored change): misses a second tab regenerating the same reply (Jev 0.05).
- Tie by the row version: a same-tab rename also bumps it, so every response would have to return the version (0.02).
- Recognise the note by its template text: breaks silently when the wording changes (0.04).
- A new `leaseUntil` field, or alert-only recovery: a new stored field for no gain over `createdAt`, or an operator
  still needed after every crash (0.02, 0.01).
