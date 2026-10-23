# [US-020] Readability: 18px Workspace scale, 44px targets, axe in CI

> Backlog task NZR-20 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: NFR-005.

## 1. User Story Statement
* **As a** Persona A, first-time AI user (PRD 1.3), tested against "Margaret, 67" (PENDING OWNER Q98)
* **I want** large, high-contrast text and big buttons everywhere in the Workspace, and a "Bigger text" button
* **So that** older and non-technical users can read and tap everything comfortably (target: axe 0 serious/critical on every Workspace page, 0 Workspace text below the body size, 0 targets under 44 x 44 px)

---

## 2. Business Context & Description
* **Background:**
  * C-20 WCAG 2.2 AA on primary journeys; C-21 axe 0 serious, 0 critical on Workspace pages, in CI; C-22 body text ≥ 18 px in the Workspace; C-23 targets ≥ 44 x 44 px; C-24 reduced motion; C-25 light mode only; C-26 viewports ([CONSTRAINTS.md](../foundation/CONSTRAINTS.md) lines 44-50). C2b exit gate: "axe 0 serious/critical" (backlog line 18).
  * Admin keeps today's density (design section 1). Only Workspace routes (manifest `isWorkspaceRoute`, US-015) get the new scale.
  * **PENDING OWNER Q105 (recommended ✅):** "20px in the builder, AAA contrast (7:1) for text, a 'Bigger text' button, works at 200% zoom." The title keeps "18px" (hard rule: titles do not change). This story builds the scale as one CSS variable so 18 → 20 px is a one-line change, and writes every check against a named constant. With Q105 accepted: body 20 px, AAA. With Q105 rejected: body 18 px, AA, no Bigger-text button (slice 4 dropped).
  * PENDING OWNER Q108: add iPad 1024 x 768 to the C-26 viewports.
  * Needs the NZR-3 clean-clone Playwright chromium download (US-003 Background: "Playwright chromium from its official download"). axe is not installed anywhere (see Current behaviour).
* **Current behaviour (d1d3a66):**
  * Type scale in `web/tailwind.config.ts:157-166`: `body` 15 px, `body-sm` 14 px, `caption` 13 px, `overline` 11 px, `heading-sm` 16 px, `heading-lg` 22 px, `display-sm` 28 px, `display-lg` 36 px. No size reaches 18 px for body text.
  * iOS Safari rule `input, select, textarea { font-size: 16px !important; }` (`web/src/index.css:309-311`) overrides any larger input size on iPad.
  * Light tokens (`web/src/index.css:59-64`, `:123-139`): bg `#fafafa`, surface `#ffffff`, sunken `#f5f5f7`, hover `#f0f0f5`; text-primary `#1a1a2e`, text-secondary `#64648c`, text-muted `#9898b0`, primary `#6366f1`, success `#22c55e`, danger `#ef4444`, warning `#f59e0b`.
  * Contrast (computed for this story, WCAG formula, on `#ffffff` / `#fafafa`):

    | token | value | ratio | AA 4.5 | AAA 7 |
    |---|---|---|---|---|
    | text-primary | `#1a1a2e` | 17.06 / 16.34 | pass | pass |
    | text-secondary | `#64648c` | 5.61 / 5.37 | pass | **fail** |
    | text-muted | `#9898b0` | 2.82 / 2.70 | **fail** | **fail** |
    | primary (link text; white on primary button) | `#6366f1` | 4.47 / 4.28 | **fail** | **fail** |
    | success | `#22c55e` | 2.28 | **fail** | **fail** |
    | danger | `#ef4444` | 3.76 | **fail** | **fail** |
    | warning | `#f59e0b` | 2.15 | **fail** | **fail** |

    So today's tokens fail AA wherever muted, primary or status colours are used as text, before any AAA goal.
  * Brand colours can be overridden per tenant at runtime (`applyBrand()`, `web/src/lib/theme.ts:24-36`, `:185-193`). The primary colour seen by a tester may not be `#6366f1`.
  * Dark mode exists (`.dark` at `index.css:204`; toggled by `theme.ts:33`). C-25: light mode is the required, tested mode.
  * Reduced motion: global rule zeroes animation and transition durations (`index.css:338-343`).
  * Tooling: `@playwright/test` 1.63.0 is a root devDependency (`package.json:121`). `axe-core` / `@axe-core/playwright` are in neither lockfile. CI (`.github/workflows/ci.yml`) runs typecheck, server build, web typecheck + build, `npm test`, LocalStack integration, CDK synth. No Playwright or axe job.
  * Web has no unit tests and no test script (design O-6). Existing e2e specs target a live deploy (`tests/e2e/tour/tour.spec.ts:9`).
* **Target behaviour:**
  * **Workspace scale:** `WorkspaceShell` (US-015) sets `data-workspace` and `data-text-size="normal"|"bigger"` on its root. Under `[data-workspace]`, CSS variables override the Tailwind sizes: `--ws-body` 20 px (PENDING Q105; 18 px if rejected), `--ws-small` 18 px (the smallest allowed Workspace text; no 11/13/14 px), `--ws-heading-sm` 22 px, `--ws-heading-lg` 26 px, `--ws-display` 32 px, line height ≥ 1.5. "Bigger" multiplies all by 1.2 (body 24 px).
  * Implementation: the Tailwind `fontSize` entries use `var(--fs-body, 15px)` etc.; `[data-workspace]` sets the vars. Admin pages keep the fallbacks (today's sizes). One change point.
  * **Align with NZR-49:** the NZR-49 v2 story adds tokens `ws-title` 32 px, `ws-heading` 24 px, `ws-body` 20 px, `ws-small` 18 px and a `--ws-scale` (1 or 1.2) variable on its `StudioPage` root. Reuse those names: `--ws-scale` drives Bigger text here too, and the `[data-workspace]` overrides are only for the existing pages (Agents, agent page, chat, Library) that use today's `text-body*` classes. If NZR-49 merged first, do not add a second scale variable.
  * **Targets:** under `[data-workspace]`, `button, a[href], [role="button"], [role="tab"], input, select, textarea, summary` have `min-height: 44px` and interactive icon buttons `min-width: 44px`. Inline text links inside paragraphs are exempt (WCAG 2.5.8 inline exception) and marked with `data-inline-link`.
  * **Contrast (PENDING Q105 AAA):** Workspace-scoped tokens: text-secondary and text-muted → `#4a4a6a` (≥ 7.46:1 on every light surface, including `#f0f0f5`), primary-for-text and primary button background → `#3730a3` (8.74:1 on `#f0f0f5`; white on it 9.93:1), danger text `#991b1b` (7.32:1), success text `#14532d` (8.02:1), warning text `#78350f` (7.99:1). If Q105 is rejected, AA tokens: muted `#64648c`, primary `#4f46e5` (6.29:1). A tenant brand colour that fails the ratio is replaced in the Workspace by the AAA token (Admin keeps the brand), and `applyBrand` logs a console warning once.
  * **iPad inputs:** the iOS rule becomes `font-size: max(16px, var(--fs-input, 16px)) !important;` so Workspace inputs render at the Workspace size.
  * **Bigger text button (PENDING Q105):** in the account menu (W-019) and in Settings › Appearance, a toggle "Bigger text" (`aria-pressed`). Stored in `localStorage` key `nz_text_size` (`"normal"|"bigger"`). Applied before first paint (read in `main.tsx` before render) so the page does not jump.
  * **200% zoom (PENDING Q105):** at 1280 x 800 with 200% zoom (CSS viewport 640 px), Workspace pages have no horizontal scroll (`document.documentElement.scrollWidth <= innerWidth`) and no clipped text (WCAG 1.4.4/1.4.10).
  * **axe + computed-style checks in CI:** a hermetic Playwright suite runs axe (WCAG 2.0/2.1/2.2 A and AA tags; plus `color-contrast-enhanced` when AAA is on) and a computed-style scan on every Workspace page at 390 x 844, 1024 x 768 (PENDING Q108) and 1440 x 900, light mode, with stubbed APIs. It fails with the element's selector, its size or ratio, and the page.
* **Out of scope:**
  * Admin page sizes and density; dark-mode contrast (C-25).
  * Fixing axe issues on Admin pages (report only, not a gate).
  * "Help me" read-aloud (US-015) and plain-word labels (Q99, US-015).
  * New Workspace pages added later: they join the page list (one array) in their own story.
* **Target Value:** (1) `npx playwright test --config tests/e2e/a11y/playwright.config.ts` reports 0 serious and 0 critical axe violations and 0 computed-style violations on all Workspace pages × 3 viewports. (2) Regression: a 12 px label or a 30 px button on any Workspace page fails CI naming the element. (3) Contrast: every Workspace text token ≥ 7:1 (AAA, PENDING Q105) on all 4 light surfaces (vitest).
* **User Persona Profile:** Persona A, first-time AI user (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: axe clean on every Workspace page
* **Given** the built web app served by `vite preview` with stubbed APIs (admin principal, populated data), light mode, and the page list `WORKSPACE_A11Y_PAGES` = `/`, `/agents`, `/agents/policy-checker`, `/chat`, `/workflows`, `/my-work`, `/library`, `/getting-started` (+ `/welcome` once US-021 lands)
* **When** the a11y suite runs axe with tags `wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa` (and `color-contrast-enhanced` when `WS_AAA === true`) at 390 x 844, 1024 x 768 and 1440 x 900
* **Then** there are 0 violations with impact `serious` or `critical` on every page × viewport
* **Test:** `tests/e2e/a11y/workspace-axe.spec.ts` › "axe: 0 serious/critical on <page> at <viewport>" (one test per pair)

### Scenario 2: Text size regression fails and names the element
* **Given** a fixture page `tests/e2e/a11y/fixtures/small-label.html` injected into the Workspace shell with `<span class="text-caption" data-probe>Due</span>` (12-13 px) and `<button data-probe style="height:30px">Go</button>`
* **When** the computed-style scan runs
* **Then** it reports 2 violations, each with the CSS selector, the measured value (`font-size: 13px < 20px`, `height: 30px < 44px`) and the page URL, and the test fails
* **And** on the real Workspace pages the same scan reports 0 violations: every visible text node's `font-size` ≥ `WS_MIN_TEXT_PX` (18; body ≥ `WS_BODY_PX` 20 PENDING Q105), every visible interactive element's box ≥ 44 x 44 px except `[data-inline-link]`
* **Test:** `tests/e2e/a11y/workspace-style.spec.ts` › "scan catches a 13px label and a 30px button"; › "Workspace pages: no small text, no small targets"

### Scenario 3: Contrast tokens meet the bar
* **Given** the Workspace token map in `web/src/lib/a11y/tokens.ts`
* **When** `npx vitest run src/lib/web-a11y/contrast.test.ts` runs
* **Then** each text token / surface pair (`#ffffff`, `#fafafa`, `#f5f5f7`, `#f0f0f5`) is ≥ 7.0:1 when `WS_AAA` is true (≥ 4.5:1 otherwise), and white on the primary button token is ≥ 7.0:1
* **And** `safeBrandColor('#6366f1')` returns the AAA token `#3730a3` (4.47:1 fails), `safeBrandColor('#1e3a8a')` returns `#1e3a8a`
* **Test:** `src/lib/web-a11y/contrast.test.ts` › "workspace tokens pass AAA on all light surfaces"; › "brand colour below the bar is replaced"

### Scenario 4: Bigger text
* **Given** a Workspace page at 1024 x 768
* **When** the user opens the account menu and presses "Bigger text"
* **Then** the button has `aria-pressed="true"`, `[data-workspace]` has `data-text-size="bigger"`, body text computes to 24 px, `localStorage.nz_text_size === "bigger"`, and after reload the first paint already has 24 px (no layout shift: CLS from `PerformanceObserver` ≤ 0.01)
* **And** Admin pages are unaffected (body stays 15 px)
* **Test:** `tests/e2e/a11y/workspace-style.spec.ts` › "Bigger text persists and applies before paint; Admin unchanged"

### Scenario 5: 200% zoom
* **Given** viewport 640 x 400 with `deviceScaleFactor: 2` (equals 1280 x 800 at 200%) and Bigger text on
* **When** each Workspace page loads
* **Then** `document.documentElement.scrollWidth <= window.innerWidth` and no element under `[data-workspace]` with text has `scrollWidth > clientWidth` while `overflow: hidden`
* **Test:** `tests/e2e/a11y/workspace-style.spec.ts` › "200% zoom: no horizontal scroll, no clipped text"

### Scenario 6: iPad input size
* **Given** WebKit project (Playwright `devices['iPad (gen 7)']`), when available on the VPS; otherwise Chromium with the `@supports (-webkit-touch-callout: none)` rule forced by a test stylesheet
* **When** the Home hero box and the chat composer render
* **Then** their computed `font-size` equals the Workspace body size, not 16 px
* **Test:** `tests/e2e/a11y/workspace-style.spec.ts` › "iOS input rule does not shrink Workspace inputs"

### Scenario 7: Runs in CI
* **Given** a pull request
* **When** the CI workflow runs
* **Then** a job "Workspace a11y (Playwright + axe)" installs from lockfiles (`npm ci`, `npm ci --prefix web`), downloads Playwright chromium (`npx playwright install chromium`), builds the web app, runs `npx playwright test --config tests/e2e/a11y/playwright.config.ts`, uploads the HTML report as an artifact, and blocks merge on failure
* **Test:** `.github/workflows/ci.yml` job `a11y`; verified by one red PR run (Scenario 2 fixture enabled) and one green run, linked in the handoff

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-15 / US-015](US-015-workspace-shell-home-agents-workflows-my-work.md) Workspace shell: Home, Agents, Workflows, My Work, Library; [NZR-3 / US-003](US-003-clean-clone-builder-workspace-on-the-vps.md) Clean-clone builder workspace on the VPS (no .env, lockfile installs)
* **UI/UX Design:** design.md section 1 (light only, reduced motion, Admin density) and every Workspace W-row: **NO-MOCK-YET, due Nov 23** ([design.md](../foundation/design.md)). Mocks must use the Workspace sizes and AAA tokens so they match the build. Bigger-text toggle lives in W-019 (account menu).
* **Non-Functional Requirements:** this story implements C-20..C-24 and C-26 for the Workspace. Constants in one place: `WS_BODY_PX = 20` (PENDING Q105; 18), `WS_MIN_TEXT_PX = 18`, `WS_TARGET_PX = 44`, `WS_AAA = true` (PENDING Q105; false). Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `a11y.text_size_changed` `{to:'normal'|'bigger'}`. Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-44). Uses US-015 `track()` (no-op until the writer exists, NOTES X2). Axe results are CI artifacts, not product events.

* **Files to change:**

| path | change |
|---|---|
| `web/tailwind.config.ts:157-166` | Each `fontSize` value becomes `var(--fs-<name>, <today's px>)` with the same line height/weight; Admin keeps today's px via the fallback. |
| `web/src/index.css` (`:root` block near `:123-139`) | Add `[data-workspace] { --fs-body: …; --fs-body-sm: …; --fs-caption: …; --fs-overline: …; --fs-heading-sm: …; … --fs-input: …; }`, the `[data-text-size="bigger"]` multipliers, the Workspace AAA colour overrides (`--color-text-secondary`, `--color-text-muted`, `--color-primary`, `--color-primary-hover`, status text colours) and the 44 px min-size rules. |
| `web/src/index.css:309-311` | `font-size: max(16px, var(--fs-input, 16px)) !important;` |
| `web/src/lib/theme.ts:185-193` (`applyBrand`) | In the Workspace, use `safeBrandColor()` for primary; Admin unchanged. |
| `web/src/main.tsx` | Before render: read `nz_text_size` and set `document.documentElement.dataset.textSize` (shell copies it to its root). |
| `web/src/components/WorkspaceShell.tsx` (US-015) | Root gets `data-workspace` and `data-text-size`. |
| `web/src/components/AccountMenu.tsx` (US-015), `web/src/pages/Settings.tsx` (Appearance) | "Bigger text" toggle (PENDING Q105). |
| `package.json` (devDependencies) + `package-lock.json` | `@axe-core/playwright` (exact version pinned, `npm install --save-dev --save-exact` by the owner or with the owner's yes; C-15). |
| `.github/workflows/ci.yml` | New job `a11y` (Scenario 7). |
| `vitest.config.ts` | No change (test under `src/`). |

* **New files:**
  * `web/src/lib/a11y/tokens.ts` — data-only: `WS_BODY_PX`, `WS_MIN_TEXT_PX`, `WS_TARGET_PX`, `WS_AAA`, `WORKSPACE_TEXT_TOKENS`, `LIGHT_SURFACES`, `contrastRatio(a,b)`, `safeBrandColor(hex)`.
  * `src/lib/web-a11y/contrast.test.ts` — vitest (node) for `tokens.ts` (Scenario 3), and a check that the CSS values in `index.css` match `tokens.ts` (read the file, regex the `[data-workspace]` block).
  * `tests/e2e/a11y/playwright.config.ts` — projects for 390 x 844, 1024 x 768, 1440 x 900 (+ optional WebKit iPad); `webServer: npm --prefix web run preview -- --port 4174 --strictPort`; `reducedMotion: 'reduce'` project for C-24; `retries: 0`.
  * `tests/e2e/a11y/pages.ts` — `WORKSPACE_A11Y_PAGES` (one array) + stub profile (reuses `tests/e2e/workspace/fixtures/api-stubs.ts`).
  * `tests/e2e/a11y/scan.ts` — in-page computed-style scanner returning `{selector, rule, value, limit}[]`.
  * `tests/e2e/a11y/workspace-axe.spec.ts`, `tests/e2e/a11y/workspace-style.spec.ts`, `tests/e2e/a11y/fixtures/small-label.html`.

* **API contract:** N/A: no API change.
* **Data changes:** Browser `localStorage` key `nz_text_size` (`"normal"|"bigger"`, default `"normal"`). No server data.
* **Security notes:**
  * New dev dependency only after the owner's yes (C-15, SECURITY.md section 6 supply chain); pin exact version; run `npm audit --omit=dev` (unchanged prod tree) and `npm audit` for the dev tree; record the licence (MPL-2.0 for axe-core).
  * The CI job uses no secrets: hermetic stubs, no `.env`, no AWS, no `CCE_E2E_URL`. Playwright download is from the official CDN only (Q78).
  * `safeBrandColor` only changes how a colour renders; it never writes branding settings.
* **Test plan:**
  * Frozen failing tests first: `src/lib/web-a11y/contrast.test.ts` (fails on today's tokens), then `workspace-style.spec.ts` (fails on today's 15 px body), then `workspace-axe.spec.ts` (expected to report today's `color-contrast` failures).
  * Commands: `npx vitest run src/lib/web-a11y/`; `npm --prefix web run build`; `npx playwright install chromium` (NZR-3); `npx playwright test --config tests/e2e/a11y/playwright.config.ts`; `npm test`; `npm --prefix web run typecheck`.
  * Manual (part of DoD): keyboard pass on Home, Agents, agent page, chat, Workflows (Tab order, visible focus, Esc closes menus) and one VoiceOver pass on iPad (C-20 "manual keyboard pass").
* **Repo rules that apply:** No route or `handler.ts` change ⇒ no drift/diagrams update. New dev dependency ⇒ owner yes + exact pin + lockfile committed. CI change ⇒ owner yes (affects every PR). Feature HANDOFF + dated session handoff.
* **Rollback:** Revert the merge. Fast path: set `WS_*` constants and the `[data-workspace]` block back (one commit). The CI job can be made non-blocking (`continue-on-error: true`) only with the owner's yes.
* **Build slices (proposal):**
  1. **Tokens + contrast test** (~1 h): `tokens.ts`, Workspace colour overrides, `safeBrandColor`. Green: Scenario 3.
  2. **Type scale + targets + iOS rule** (~2 h): Tailwind vars, `[data-workspace]` block, 44 px rules, fix the pages that break. Green: Scenarios 2, 6.
  3. **axe + CI** (~2 h, after owner yes on the dependency): a11y config, axe spec, CI job. Green: Scenarios 1, 7.
  4. **Bigger text + 200% zoom** (~1.5 h, PENDING Q105): toggle, pre-paint read, zoom fixes. Green: Scenarios 4, 5.
* **Agent gotchas:**
  * Tailwind `fontSize` tuples take a string for the size; `var(--fs-body, 15px)` works, but `text-[15px]` arbitrary classes in components bypass it. Grep `text-\[` under `web/src` (4 files use `text-[<n>…]` today) and fix the Workspace ones.
  * axe `color-contrast` cannot judge text over gradients/blur (Home hero shapes, US-017); it reports them as "incomplete", not violations. Check those by the computed-token test instead.
  * Run axe after fonts load (`await page.evaluate(() => document.fonts.ready)`) and after skeletons resolve, or it flags shimmer placeholders.
  * The tester's tenant brand may differ from `#6366f1`; test with the default brand and with one failing brand colour.
  * Do not scope by route string in CSS; scope by the `data-workspace` attribute that the shell sets (so Admin pages under `/overview` are not affected).
  * WebKit may not install on the 3.9 GB VPS; keep it an optional project, not a gate.

---

## 5. Estimation & Tracking
* **Epic Name:** M2b Workspace + testers (cycle C2b Workspace + Admin console + testers, 2026-11-24 to 2026-12-07)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 4 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** a11y

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases (regression fixture, brand colour, iPad input, 200% zoom).
- [ ] UX/UI designs are attached and finalized: all Workspace W-rows are **NO-MOCK-YET, due Nov 23**, drawn at the Workspace sizes and tokens (MOCK screenshots; NO-MOCK-YET entries must be mocked before the step starts, Q77).
- [ ] Dependencies have been identified and are unblocked (NZR-15; NZR-3 Playwright chromium; owner yes for `@axe-core/playwright` and for the CI job).
- [ ] Owner answer on Q105 (20 px / AAA / Bigger text / 200% zoom) and Q108 (iPad viewport) recorded, or defaults accepted.
- [ ] The team has reviewed and estimated the story points (5 pts; re-checked at the Nov 9 re-plan, Q71; NOTES proposes 8 with Q105).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail).
- [ ] Peer code review is completed and approved. T2: fresh Claude critic + free checks (`npm audit`, secret scan, typecheck, lockfile diff limited to the one approved dev dependency) + step maid (Q68).
- [ ] A frozen failing test came first (red SHA recorded); the gate is green on a clean checkout of the exact HEAD: `npx vitest run src/lib/web-a11y/` and `npx playwright test --config tests/e2e/a11y/playwright.config.ts`; the CI `a11y` job is green on the PR; full `npm test` green.
- [ ] QA: the fresh critic re-runs the gate against these criteria, plus the manual keyboard and VoiceOver passes. UAT: the owner accepts a short demo (Q51) on iPad-size with Bigger text on and off.
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff (axe report link); the Workspace scale, AAA tokens and the a11y job promoted to README/ADR; CONSTRAINTS C-22/C-26 updated if Q105/Q108 are accepted.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists.
