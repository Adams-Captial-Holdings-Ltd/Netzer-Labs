# NZR-3 UAT transcript (G3)

- Date: 2026-10-24
- Walker: fresh UAT agent (did not build the story)
- Persona: Factory operator (owner running the VPS gauntlet)
- Worktree: /root/wt/nzr-3, branch `feature/nzr-3-clean-clone-builder-workspace-on-the-vps`, HEAD `eec716f`
- Story kind: non-UI. The deliverable is a factory CLI (`scripts/factory/netzar-clone/netzar-clone.sh` + `hooks/pre-push`). It has no HTTP surface.

## Request/response log (local app, http://127.0.0.1:3900)

| # | method | path | auth | status | body |
|---|---|---|---|---|---|
| 1 | GET | /health | `Bearer ****` (E2E_TOKEN, masked) | 200 | `{"status":"ok","uptime":52.688804417,"time":"2026-10-24T17:54:03.035Z"}` |

The app is up, but no route exercises `netzar-clone.sh` (`init|fetch|check|install|push`). Per the walker brief, every scenario was therefore exercised through the story's named tests. Those tests drive the real script against a temp bare repo used as `origin`, with stub `npm`/`npx`/`free` on `PATH`, so there is no network.

## Test run

Command: `npx vitest run scripts/factory/netzar-clone/netzar-clone.test.ts --reporter=verbose`
(the vitest wrapper runs each case of `scripts/factory/netzar-clone/test-netzar-clone.sh` and requires exit 0 and empty output)

Result: `Test Files 1 passed (1)`, `Tests 21 passed (21)`, duration 10.96s, started 17:53:42.

## Scenario walk

| # | Scenario | Named test(s) (bash case) | Result |
|---|---|---|---|
| 1 | A fresh clone is secret-free | "check passes on a fresh clone and ignores tracked env templates" (`t_check_clean`). It asserts exit 0, `CLONE CLEAN <sha>`, report `[sha,[],[],0,0]`, and `.env.example` in `tracked_templates` | PASS |
| 2 | A secret in the clone fails the check | "check fails on an untracked .env, key file or nvapi- string without echoing the value" (`t_check_dirty`). It asserts exit 1, three `CLONE NOT CLEAN:` lines, that the value is absent from stdout and from the report, and report `[[".env"],["id_rsa"],1]` | PASS |
| 3 | Fetch before every build; dirty tree refused | "fetch reports the new origin sha and refuses a dirty tree" (`t_fetch`). It asserts exit 3 `REFUSED: dirty tree` with origin/development unmoved, then exit 0 `FETCHED origin/development <new sha>` | PASS |
| 4 | Lockfile-only installs, one at a time | "install runs the three commands serially and in order" (`t_install_serial`). It asserts start/end order of the 3 commands, report steps with exit 0, `min_avail_mb`/`peak_used_mb`, and empty `git status --porcelain` on both lockfiles | PASS (stub run). The attended real VPS install (`install-<ts>.json`) is owner-attended evidence and is not part of this walk |
| 5 | Install refuses drift and low memory | "install fails on lockfile drift" (`t_install_drift`): exit 1 `LOCKFILE CHANGED: package-lock.json`, no later command. "install aborts below 250 MB available" (`t_install_lowmem`): exit 1 `ABORTED: low memory (100 MB available)` | PASS |
| 6 | Push without an owner yes is refused and logged | "push is refused without an approval record and logged" (`t_push_refused`). Plain push, `--no-verify origin HEAD` and the explicit-URL push all fail, and the ref never reaches origin. The log line is `[sha, refs/heads/gauntlet/x, refused, "no owner yes for <sha12> -> refs/heads/gauntlet/x"]` | PASS |
| 7 | Approved push only for approved SHA+ref, single use | "approved push is allowed once, only for its sha and ref" (`t_push_approved`). The first push exits 0 and reaches origin. Reuse exits 4 and so does a different SHA, both with `no owner yes for <sha12> -> <ref>`. Log results are `["allowed","refused","refused"]` | PASS |

Hardening cases in the same run, all passing: tracked-file secret, scanner fail-closed, scanner on modified files only, hook placement and hash, atomic single-use hook, no push creds, install lock, attempt-log write failure, fetch credential helper, low-memory process-group kill, bad approvals, install stamp.

## Not covered here
- Attended real `init → fetch → check → install → check` on the VPS with real npm and chromium (story DoD, owner present, Q78).
- Waived limit (owner, 2026-10-24): a builder sharing the unix user can borrow `gh` credentials. Deferred to NZR-40.
