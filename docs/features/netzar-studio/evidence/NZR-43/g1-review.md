# G1 review 1 — NZR-43 (fix/nzr-43-review-1)

HEAD: b755e0772fb7b5d12afda48f399c80cb3643f7d1
Diff: `origin/integration/netzar-studio...HEAD` excluding `docs/features/netzar-studio` (5 files, +88/-3)
Tier: T3. Reviewer: fresh critic (no build transcript).

## Scope of the delta
Review-fix follow-ups on the merged NZR-43 work:
1. `configNameSchema` (Zod, `^[A-Za-z0-9_.:-]{1,128}$`) checked first in `configAccess` → 400 `invalid_config_param`, before any store call or audit row.
2. `carriesMaskedSecret(key, value)` → POST refuses a value still carrying a `****xxxx` mask (whole secret key, or secret-shaped JSON field at any depth) with 400 `masked_value_rejected`, before `getConfig`/`setConfig`.
3. E2E script logs method/path/status only (no bodies); adds masked write-back + oversized-name checks.
4. Drift-gate line in `docs/diagrams/request-lifecycle.md` for the `config_access_denied` audit action.

## Checks
- **AC coverage:** Scenarios 1–7 unchanged by this delta; story tests green (`config-secrets`, `config-policy`, `authz-matrix`, `config-cost-guard`: 4 files, 155/155 pass). New F43-12 / F43-13 cover the two new branches incl. the 128 boundary and the "non-secret key may hold asterisks" negative.
- **Auth bypass:** name validation runs inside `configAccess`, which every one of the 4 routes calls before any store call; POST still sits behind the `requiredRole` admin gate. Validation only narrows input; no path becomes reachable that wasn't before. Percent-decoded names still hit the exact-match policy.
- **Secret leaks:** E2E no longer prints response bodies. The new 400 bodies carry no value. The masked-value check runs before `getConfig`, so no extra read.
- **Broken callers:** grep of `getConfig/setConfig` in `src`, `web/src`, `scripts`: every literal key matches the new charset; the only dynamic key (`oauth/slack_app_${agentId}`) is in a denied category and uses a dedicated path, not the generic route. The SPA keys listed in the story all pass.
- **Scope creep:** none. Small, on-topic diff. Uses zod (already a dependency).

## Findings (none blocking)
1. **low** — `carriesMaskedSecret` has no unit case in `src/lib/state/config-policy.test.ts`. Only route test F43-13 covers it (non-JSON, nested-array, non-string-masked `****` cases are untested at the unit level).
2. **low** — `tests/e2e/nzr-43/run.mjs:88`: the "still holds the real value" check doesn't assert `status === 200` and passes no detail. It's still correct, because an overwritten `****zzzz` would read back as `****`.
3. **info** — A 400 `invalid_config_param` writes no audit row (by design, per the doc comment). Malformed-name probing leaves only access-log traces.
4. **info** — `MASKED` (`^\*{4}[^]{0,4}$`) also refuses a real secret value or a placeholder that happens to look like `****` plus up to 4 characters. The false-positive risk is negligible, and refusing is the safe default.

## Not verified
- `npm run typecheck` and full `npm test` were not run here (the permission gate blocked typecheck). They are left to G2.
- I didn't check whether `docs/diagrams.map` maps `audit-writer.ts` to `request-lifecycle.md`. The `diagrams-drift.mjs` CI gate covers it.

## Verdict
PASS. 4 findings: 0 high, 0 medium, 2 low, 2 info.
