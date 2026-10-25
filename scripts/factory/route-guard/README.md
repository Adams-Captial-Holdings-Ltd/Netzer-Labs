# route-guard (NZR-40)

Factory helper for the VPS gauntlet. Checks a role's route (builder, critic, security, reviewer) against the owner's rules before it starts, and logs every pick and refusal. Node built-ins only; no network; reads no key.

Install: copy `route-guard.mjs` to `/root/.claude/bin/route-guard.mjs`. Tests: `npx vitest run scripts/factory/route-guard`. Self-check: `node route-guard.mjs selftest`.

```
route-guard.mjs check   --slug S --step ID --role builder|critic|security|reviewer --provider codex|claude|nvidia|openrouter --model M --session SID
route-guard.mjs jev     --slug S --step ID (--question Q --choice C --confidence N | --unavailable --advisor R --answer C)
route-guard.mjs summary --slug S --step ID
```

Exit codes: 0 ok, 2 usage, 4 refused or missing, 5 log or consent file unreadable (nothing recorded). Env: `GAUNTLET_ROUTES` (log, default `~/.claude/plans/<slug>-logs/routes.jsonl`), `GAUNTLET_CONSENT` (default `~/.claude/gauntlet-consent.json`).

Rules: `nvidia` needs the owner's consent record; an `nvidia` builder also needs `build_bakeoff_passed`; the critic is `claude` in a session no builder of the step used; `codex` may not review or security-review a step Codex built; a refused builder prints `FALLBACK: codex/same rung`.

## Doc edits for the factory skill copies (outside this repo)

These files live under `/root/.claude` and `/root/.hermes`, outside the builder's reach. The coordinator applies them; each is short.

1. `SKILL.md`, end of Build Ladder (before `# Effort and Usage Routing`): new section **VPS routing rules (owner, Q51/Q59/Q65)**. Call `route-guard.mjs check` before every Codex launch, critic dispatch, security review and external review. A refused builder uses the printed fallback. Put the `route-guard.mjs summary` line in the step log. Session ids are coordinator-generated UUIDs per launch, written to the work order header and the route log (not verified by the provider). NVIDIA needs `~/.claude/gauntlet-consent.json`, written only by the coordinator after the owner's yes in chat. Add to the work order `DO NOT` list: never write `gauntlet-consent.json`.
2. `SKILL.md`, Codex Authorship Invariant and Verification of Claude-Built Work: add "Codex never reviews code Codex built (Q51). It may review Claude-built code."
3. `SKILL.md`, Builder / Critic Separation: add "Enforced by `route-guard.mjs`: the critic's session id must differ from every builder session of the step."
4. `references/review-gauntlet.md`, L3 row and readiness row: L3 runs only when the consent record exists; otherwise `REVIEW: L3 NOT RUN (no owner yes on NVIDIA terms)`. Bake-off results come from `gauntlet-evals.mjs report`.
5. Hermes `references/hermes-adaptation.md` lines 21 and 25-35: replace the model routing and build provider text with: Codex builds; fresh Claude critic; Codex reviews only others' code; NVIDIA only after the owner's yes and a bake-off; Netzar uses the Claude copy (Q59).
