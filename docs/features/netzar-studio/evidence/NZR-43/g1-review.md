G1 verdict for NZR-43 at HEAD 1c60454 is **PASS**, but the review file was not written: the write to `/root/.hermes/netzar-runner/runs/NZR-43/g1-review-1.md` was refused for lack of permission. Grant write access to that run folder and I'll write it; the full review text is ready.

There are no high or medium findings. All 4 `/config` routes check the category policy before touching the store, and every test is green: 166 in the story's own test run and 4669 in the full suite. Typecheck, secret-scan and diagrams-drift could not be run (permission refused), so the next gate must run them.

| Scenario | Result |
|---|---|
| 1. Pages that read config work as before (viewer and seat-user, themes unchanged byte for byte) | Covered by F43-6 and a permission-matrix row. Every page's config read and write uses an allowed category. |
| 2. `oauth`, `oauth_state`, `mcp` refused on all 4 routes, every role incl. owner, nothing read from the store | Covered by F43-1, -2, -3, -8 |
| 3. Unknown names (`OAUTH`, `oau%74h`, `constructor`, `__proto__`) refused the same way | Covered by F43-4 |
| 4. Secret-looking values masked in responses, the write reply, the audit row and the log line | Covered by F43-5 and F43-9, plus unit tests |
| 5. Admin-only and operator-only categories | Covered by F43-10 and a permission-matrix row |
| 6. Every refusal audited, even with auditing switched off | Covered by F43-7 and an audit-writer test |
| 7. Audit write or store down still means a refusal, never a 200 | Covered by F43-7b |
| 8. Secret rotation and handoff | Owner step after merge. The runbook, the finding #1 status line and the `config-exposure` query are in place. |

The failing tests were committed first (`f18a533`), before the fix.

**Low and info findings (non-blocking):**
- **Low:** the new masking of the free-text `reason` hides too much. It hides any written value of 4+ characters even when the key isn't secret, so "set true for launch" becomes "set **** for launch". It also hides any 16+ character word with a digit, such as IDs or commit hashes. Nothing leaks, but audit text gets harder to read. This masking (and its test F43-11) goes slightly beyond the story.
- **Low:** the story's `SECURITY.md` updates (§2a row B1/I, §7 risk #2) and the rotation handoff are not done yet. The story ties them to the merge SHA, so they come after merge, but they need tracking before Done is signed off.
- **Low:** the refusal audit row stores the requested category and key exactly as sent, with no length cap. Those rows can't be switched off, so someone probing the API can make them very large.
- **Info:** if someone reads a value with a masked field and posts it back, the stored secret is overwritten with `****wxyz`. No page in the app does this today.
- **Info:** typecheck, secret-scan and diagrams-drift were not run, as noted above.

{"gate":"G1","verdict":"PASS","findings_total":5,"findings_blocking":0,"findings":[{"severity":"low","text":"maskReason over-masks non-secret reasons: any known value >=4 chars (e.g. 'true') and any 16+ char letter+digit word (UUIDs, SHAs) become ****; hurts audit readability; slightly beyond the story's frozen scope (F43-11)"},{"severity":"low","text":"Story's SECURITY.md updates (§2a B1/I, §7 risk #2) and HANDOFF 'NZR-43 rotation' not done yet; deferred to merge SHA, must be tracked before DoD"},{"severity":"low","text":"config_access_denied detail.category/detail.key are attacker-chosen and uncapped; probing can bloat always-audited rows; truncate (~128 chars)"},{"severity":"info","text":"Masked values break round-trips: GET a JSON value with a masked field (e.g. media/servers_json bearerToken) then POST it back overwrites the real secret with ****wxyz; no SPA screen does this"},{"severity":"info","text":"Reviewer could not run npm run typecheck, secret-scan.mjs or diagrams-drift.mjs (permission denied); full vitest 4669/4669 green; review file write also denied"}]}