# NZR-40 UAT transcript (G3)

CLI under test: `scripts/factory/route-guard/route-guard.mjs` (node v26.12.1). No HTTP surface: the story is CLI-only (§4 "API contract: N/A"), so every request below is a CLI invocation; env paths are per-scenario temp files. No token used.

## Scenario 1: Routed step (happy path)

```
$ route-guard.mjs jev --slug uat --step nzr-12.s1 --question model --choice sol --confidence 0.86
exit 0
JEV recorded
```
```
$ route-guard.mjs check --slug uat --step nzr-12.s1 --role builder --provider codex --model gpt-6-sol --session A
exit 0
ROUTE OK
```
```
$ route-guard.mjs check --slug uat --step nzr-12.s1 --role critic --provider claude --model opus --session B
exit 0
ROUTE OK
```
```
$ route-guard.mjs summary --slug uat --step nzr-12.s1
exit 0
ROUTE: builder codex/gpt-6-sol (s:A) | critic claude/opus (s:B) | JEV: model -> sol (0.86)
```
Route log:
```json
{"ts":"2026-10-25T22:19:06.486Z","step":"nzr-12.s1","kind":"jev","question":"model","choice":"sol","confidence":"0.86"}
{"ts":"2026-10-25T22:19:06.515Z","step":"nzr-12.s1","role":"builder","provider":"codex","model":"gpt-6-sol","session":"A","result":"allowed","reason":null,"fallback":null}
{"ts":"2026-10-25T22:19:06.543Z","step":"nzr-12.s1","role":"critic","provider":"claude","model":"opus","session":"B","result":"allowed","reason":null,"fallback":null}
```

- PASS: jev recorded, exit 0
- PASS: builder check exit 0 + ROUTE OK
- PASS: critic check exit 0 + ROUTE OK
- PASS: route log has two "allowed" lines
- PASS: summary prints exact line
- PASS: no consent file was present

**Result: PASS**

## Scenario 2: No NVIDIA builder before consent

```
$ route-guard.mjs check --slug uat --step s2 --role builder --provider nvidia --model nemotron-x --session C
exit 4
ROUTE REFUSED: nvidia needs the owner's yes on the NVIDIA free-tier terms (Q65)
FALLBACK: codex/same rung
```
Route log:
```json
{"ts":"2026-10-25T22:19:06.597Z","step":"s2","role":"builder","provider":"nvidia","model":"nemotron-x","session":"C","result":"refused","reason":"no_nvidia_consent","fallback":"codex"}
```

- PASS: exit 4
- PASS: REFUSED message
- PASS: FALLBACK: codex/... printed
- PASS: log result refused / no_nvidia_consent / fallback codex

**Result: PASS**

## Scenario 3: No NVIDIA reviewer before consent

```
$ route-guard.mjs check --slug uat --step s3 --role reviewer --provider nvidia --model nemotron-x --session D
exit 4
ROUTE REFUSED: nvidia needs the owner's yes on the NVIDIA free-tier terms (Q65)
LAYER: L3 NOT RUN (no owner yes on NVIDIA terms)
```
Route log:
```json
{"ts":"2026-10-25T22:19:06.625Z","step":"s3","role":"reviewer","provider":"nvidia","model":"nemotron-x","session":"D","result":"refused","reason":"no_nvidia_consent","fallback":null}
```

- PASS: exit 4
- PASS: REFUSED message
- PASS: LAYER: L3 NOT RUN line
- PASS: no fallback substituted

**Result: PASS**

## Scenario 4: Codex never reviews code Codex built

```
$ route-guard.mjs check --slug uat --step s4a --role builder --provider codex --model gpt-6-sol --session A
exit 0
ROUTE OK
```
```
$ route-guard.mjs check --slug uat --step s4a --role reviewer --provider codex --model gpt-6-sol --session R
exit 4
ROUTE REFUSED: codex built this step; codex may not review it (Q51)
```
```
$ route-guard.mjs check --slug uat --step s4a --role security --provider codex --model gpt-6-sol --session S
exit 4
ROUTE REFUSED: codex built this step; codex may not review it (Q51)
```
```
$ route-guard.mjs check --slug uat --step s4b --role builder --provider claude --model opus --session A2
exit 0
ROUTE OK
```
```
$ route-guard.mjs check --slug uat --step s4b --role reviewer --provider codex --model gpt-6-sol --session R2
exit 0
ROUTE OK
```
Route log:
```json
{"ts":"2026-10-25T22:19:06.656Z","step":"s4a","role":"builder","provider":"codex","model":"gpt-6-sol","session":"A","result":"allowed","reason":null,"fallback":null}
{"ts":"2026-10-25T22:19:06.680Z","step":"s4a","role":"reviewer","provider":"codex","model":"gpt-6-sol","session":"R","result":"refused","reason":"codex_self_review","fallback":null}
{"ts":"2026-10-25T22:19:06.704Z","step":"s4a","role":"security","provider":"codex","model":"gpt-6-sol","session":"S","result":"refused","reason":"codex_self_review","fallback":null}
{"ts":"2026-10-25T22:19:06.734Z","step":"s4b","role":"builder","provider":"claude","model":"opus","session":"A2","result":"allowed","reason":null,"fallback":null}
{"ts":"2026-10-25T22:19:06.764Z","step":"s4b","role":"reviewer","provider":"codex","model":"gpt-6-sol","session":"R2","result":"allowed","reason":null,"fallback":null}
```

- PASS: codex reviewer on codex-built step: exit 4 + message
- PASS: codex security on codex-built step: exit 4 + message
- PASS: codex reviewer on claude-built step: exit 0

**Result: PASS**

## Scenario 5: The critic is a fresh Claude session

```
$ route-guard.mjs check --slug uat --step s5 --role critic --provider claude --model opus --session B
exit 4
ROUTE REFUSED: no builder recorded for this step
```
```
$ route-guard.mjs check --slug uat --step s5 --role builder --provider codex --model gpt-6-sol --session A
exit 0
ROUTE OK
```
```
$ route-guard.mjs check --slug uat --step s5 --role critic --provider claude --model opus --session A
exit 4
ROUTE REFUSED: critic session A also built this step
```
```
$ route-guard.mjs check --slug uat --step s5 --role critic --provider codex --model gpt-6-sol --session B
exit 4
ROUTE REFUSED: the critic must be a fresh Claude session
```
Route log:
```json
{"ts":"2026-10-25T22:19:06.789Z","step":"s5","role":"critic","provider":"claude","model":"opus","session":"B","result":"refused","reason":"no_builder","fallback":null}
{"ts":"2026-10-25T22:19:06.816Z","step":"s5","role":"builder","provider":"codex","model":"gpt-6-sol","session":"A","result":"allowed","reason":null,"fallback":null}
{"ts":"2026-10-25T22:19:06.845Z","step":"s5","role":"critic","provider":"claude","model":"opus","session":"A","result":"refused","reason":"critic_reused_session","fallback":null}
{"ts":"2026-10-25T22:19:06.875Z","step":"s5","role":"critic","provider":"codex","model":"gpt-6-sol","session":"B","result":"refused","reason":"critic_not_claude","fallback":null}
```

- PASS: reused session: exit 4 + "critic session A also built this step"
- PASS: codex critic: exit 4 + "the critic must be a fresh Claude session"
- PASS: premature critic: exit 4 + "no builder recorded for this step"

**Result: PASS**

## Scenario 6: Consent alone does not let NVIDIA build

Consent fixture:
```json
{"nvidia":{"terms_yes":true,"ts":"2026-10-25T00:00:00Z","owner_text":"yes, I read the terms"}}
```
```
$ route-guard.mjs check --slug uat --step s6 --role builder --provider nvidia --model nemotron-x --session N1
exit 4
ROUTE REFUSED: nvidia builders need a passed bake-off (Q65)
FALLBACK: codex/same rung
```
```
$ route-guard.mjs check --slug uat --step s6 --role reviewer --provider nvidia --model nemotron-x --session N2
exit 0
ROUTE OK (advisory until bake-off qualifies)
```
Route log:
```json
{"ts":"2026-10-25T22:19:06.908Z","step":"s6","role":"builder","provider":"nvidia","model":"nemotron-x","session":"N1","result":"refused","reason":"no_build_bakeoff","fallback":"codex"}
{"ts":"2026-10-25T22:19:06.940Z","step":"s6","role":"reviewer","provider":"nvidia","model":"nemotron-x","session":"N2","result":"allowed","reason":null,"fallback":null}
```

- PASS: builder: exit 4 + bake-off message
- PASS: builder: FALLBACK: codex/...
- PASS: reviewer: exit 0 + advisory note

**Result: PASS**

## Scenario 7: Broken inputs fail closed

Fixture: consent file contains `{not json`
```
$ route-guard.mjs check --slug uat --step s7 --role builder --provider codex --model gpt-6-sol --session A
exit 5
ROUTE NOT CHECKED: /root/.hermes/cache/scratch/nzr40-uat-QLn4WB/consent.json is unreadable; fix it by hand
```
Fixture: route log second line is `not json`
```
$ route-guard.mjs check --slug uat --step s7 --role builder --provider codex --model gpt-6-sol --session A
exit 5
ROUTE NOT CHECKED: /root/.hermes/cache/scratch/nzr40-uat-yHnwfy/routes.jsonl is unreadable; fix it by hand
```
```
$ route-guard.mjs check --slug uat --step s7 --role wizard --provider codex --model m --session A
exit 2
usage: route-guard.mjs check|jev|summary --slug S --step ID ... | selftest (see file header)
role must be one of builder|critic|security|reviewer
```
```
$ route-guard.mjs check --slug uat --step s7 --role builder --provider acme --model m --session A
exit 2
usage: route-guard.mjs check|jev|summary --slug S --step ID ... | selftest (see file header)
provider must be one of codex|claude|nvidia|openrouter
```

- PASS: corrupt consent: exit 5 + NOT CHECKED message
- PASS: corrupt consent: nothing recorded
- PASS: corrupt log: exit 5 + NOT CHECKED message
- PASS: corrupt log: nothing appended
- PASS: unknown --role: exit 2 + usage line
- PASS: unknown --provider: exit 2 + usage line

**Result: PASS**

## Scenario 8: Jev is down

```
$ JEV_SH=/root/.hermes/cache/scratch/nzr40-uat-aYPb0w/jev-stub.sh $JEV_SH model nzr-8.s1
exit 1
```
```
$ route-guard.mjs check --slug uat --step s8 --role builder --provider codex --model gpt-6-sol --session A
exit 0
ROUTE OK
```
```
$ route-guard.mjs check --slug uat --step s8 --role critic --provider claude --model opus --session B
exit 0
ROUTE OK
```
```
$ route-guard.mjs summary --slug uat --step s8
exit 4
MISSING: no Jev or advisor pick recorded
```
```
$ route-guard.mjs jev --slug uat --step s8 --unavailable --advisor sonnet --answer sol
exit 0
JEV recorded
```
```
$ route-guard.mjs summary --slug uat --step s8
exit 0
ROUTE: builder codex/gpt-6-sol (s:A) | critic claude/opus (s:B) | JEV: unavailable -> advisor (sonnet): sol
```
Route log:
```json
{"ts":"2026-10-25T22:19:07.082Z","step":"s8","role":"builder","provider":"codex","model":"gpt-6-sol","session":"A","result":"allowed","reason":null,"fallback":null}
{"ts":"2026-10-25T22:19:07.109Z","step":"s8","role":"critic","provider":"claude","model":"opus","session":"B","result":"allowed","reason":null,"fallback":null}
{"ts":"2026-10-25T22:19:07.166Z","step":"s8","kind":"jev","unavailable":true,"advisor":"sonnet","answer":"sol"}
```

- PASS: stubbed JEV_SH exits 1
- PASS: no pick: summary exit 4 + MISSING line
- PASS: advisor pick recorded, exit 0
- PASS: summary carries "JEV: unavailable -> advisor (sonnet): sol"

**Result: PASS**

