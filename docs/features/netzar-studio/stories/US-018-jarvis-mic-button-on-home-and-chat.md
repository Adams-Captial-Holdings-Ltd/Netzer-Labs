# [US-018] Jarvis: mic button on Home and chat; orb page to Developer tools

> Backlog task NZR-18 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: NFR-005.

## 1. User Story Statement
* **As a** Persona A, first-time AI user (PRD 1.3), tested against "Margaret, 67" (PENDING OWNER Q98)
* **I want** to tap one big mic button, say what I need, and see my words in the text box before I send them
* **So that** describing a process does not depend on typing (target: words show in the box ≤ 10 s after I stop for a 15-second recording, and nothing is ever sent without my tap)

---

## 2. Business Context & Description
* **Background:**
  * Backlog marks NZR-18 "cut 4th if late" (Q72).
  * **PENDING OWNER Q100 (recommended ✅):** the describe screen starts with 6 example cards plus "Something else" with a big mic button, which "means the mic moves from 'cut 4th' (NZR-18) into the slice (~+2 pts in C2a)". If accepted, the shared mic component and the transcribe API (slices 1–2 below) are built in the C2a slice with NZR-23. This story then keeps only the Home and chat placements and the Jarvis move (slices 3–4), and is no longer a cut candidate. See NOTES.
  * design.md S-011: the Jarvis orb page moves to **Admin > Developer tools**; the mic moves to Home and chat (W-017).
  * NFR-005 (WCAG 2.2 AA): the mic has an accessible name and state. NFR-002 / C-02: visible acknowledgement within 3 s.
* **Current behaviour (d1d3a66):**
  * The only voice feature is Jarvis: a WebSocket to `/api/jarvis/voice` (`src/adapters/dashboard/jarvis.ts:1571`) streaming to Bedrock Nova Sonic (`src/lib/voice/nova-sonic.ts:349`). It is a spoken conversation (Jarvis talks back), not dictation into a text box.
  * Mic access: `voiceClient.startListening()` calls `getUserMedia` and sets `jarvisMicPermission` to `'unavailable'` (no API) or `'denied'` (any rejection) (`web/src/lib/jarvis/voiceClient.ts:181-197`; signal at `web/src/lib/jarvis/tools.ts:151`).
  * Admin off switches: kill switch `jarvis_voice_disabled` (`src/lib/state/kill-switches-repo.ts:291`), read fail-closed in `jarvis.ts:175`; the manifest reports `voiceEnabled` (`jarvis.ts:186`), copied into `jarvisVoiceEnabled` (`tools.ts:255`). Env `CCE_TRANSCRIBE_DISABLED=1` turns off Transcribe for media (`src/lib/media/process.ts:294`, `:509`).
  * Batch speech-to-text already exists: `transcribeAudio({ s3Uri, mimeType, jobNameSuffix })` (`src/lib/transcribe/transcriber.ts:74-95`, `:117`), 60 s poll deadline (`:29`), auto language detect (`:146-147`). Chat already transcribes uploaded audio and adds it to the message as "[transcribed audio] …" (`src/adapters/dashboard/handler.ts:2378-2381`), but that sends immediately; there is no "transcribe into the box for review" path.
  * Chat upload presign: `POST /api/chat/uploads` (`chat:read`), audio allowed, 30 MB cap, key `uploads/chat/<sha256(identity)[:16]>/<uuid>/<name>` (`handler.ts:306-309`, `:3145-3168`; `src/lib/chat/attachments.ts:1-22`). Browser helper `stageAttachment()` (`web/src/lib/chat/uploads.ts:20-45`).
  * No web code uses `MediaRecorder` (grep: only `voiceClient.ts` touches the mic).
  * `JarvisWidget` (floating orb) renders on every signed-in route (`web/src/App.tsx:310`). `/jarvis` is ungated and in the sidebar "Core" group for everyone (`App.tsx:302`, `web/src/components/Sidebar.tsx:116`).
* **Target behaviour:**
  * **Shared mic button (W-017):** `MicButton` with states idle, asking for mic access, mic blocked, listening (with a live timer and a "Stop" label), thinking, error, voice off by admin. One tap starts, one tap stops; it auto-stops at 60 s (the transcriber's wait window).
  * Recording: `MediaRecorder` with `audio/webm;codecs=opus` (Chrome, Edge, Firefox) or `audio/mp4` (Safari/iPad); the chosen type comes from `MediaRecorder.isTypeSupported`. The mic tracks are stopped as soon as recording stops.
  * Upload via the existing `stageAttachment()` (`/api/chat/uploads`), then a new `POST /api/voice/transcribe { key }` returns `{ text }`. The text is **inserted into the box** at the cursor (Home hero, chat composer, and the describe screen once NZR-23 exists). Nothing is sent; the user reviews and taps Send.
  * Thinking state shows within 3 s of Stop (C-02); the text appears when the transcript returns.
  * When the admin has voice off (manifest `voiceEnabled === false`, kill switch `jarvis_voice_disabled`, or `CCE_TRANSCRIBE_DISABLED=1`), the button shows disabled with the text "Voice is turned off by your administrator." Typing works.
  * **Jarvis orb page to Developer tools:** `/jarvis` keeps its URL. It is listed only in Admin > Developer tools (US-016 grouping) and no longer in any Workspace nav. The floating `JarvisWidget` is not rendered on Workspace routes (Home, Agents, chat, Workflows, My work, Library), where the mic replaces it; it stays on Admin routes. Recommendation, confirm at mock review (NOTES).
* **Out of scope:**
  * Spoken replies, wake word, continuous conversation: Jarvis keeps them on `/jarvis`.
  * Live (streaming) dictation: batch transcription only.
  * The describe-screen placement: NZR-23 (or C2a slice under Q100) mounts the same `MicButton`.
  * "Read it aloud" for Help me (US-015, PENDING Q107; local speech synthesis, not this API).
  * Developer tools index route `/admin/developer` (W-035): not added (US-016 NOTES).
  * Removing Jarvis, its kill switches, or any voice code. Nothing deleted.
* **Target Value:** (1) For a 15 s clip on a local stack with the Transcribe call stubbed to 2 s, text appears in the box ≤ 10 s after Stop in 19 of 20 runs; thinking state shows ≤ 3 s in 20 of 20. (2) In NZR-32, count `voice.used` per tester; target: ≥ 1 of 5 testers use the mic without being told (signal, not a gate). (3) 0 messages sent without a Send tap (Scenario 1 asserts no `/api/chat` or describe request).
* **User Persona Profile:** Persona A, first-time AI user (PRD 1.3). PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Speak, review, then send
* **Given** Home (US-017) with a principal holding `chat:read`, the manifest stub `voiceEnabled: true`, Chromium launched with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`, and `POST /api/voice/transcribe` stubbed to `200 { "text": "Check new policies for missing signatures" }`
* **When** the user taps the button named "Start speaking", waits 2 s, and taps the same button (now named "Stop speaking")
* **Then** the hero box contains "Check new policies for missing signatures", focus is in the box, and no request was made to `/api/chat*` or `/api/workflows*`
* **And** the button returned to "Start speaking" with `aria-pressed="false"`, and every `MediaStreamTrack` from the recording has `readyState === 'ended'`
* **Test:** `tests/e2e/workspace/mic.spec.ts` › "dictation fills the Home box and sends nothing"

### Scenario 2: Mic blocked
* **Given** an init script that makes `navigator.mediaDevices.getUserMedia` reject with `DOMException('…','NotAllowedError')`
* **When** the user taps "Start speaking"
* **Then** a message shows: "Your browser is blocking the microphone. To use it, allow the microphone for this site in your browser settings, then try again. You can also type." The box stays editable, and the button is named "Microphone blocked"
* **And** with `navigator.mediaDevices` undefined, the message is "This browser can't use a microphone here. You can type instead."
* **Test:** `tests/e2e/workspace/mic.spec.ts` › "blocked or missing mic explains and keeps typing working"

### Scenario 3: Voice off by the admin
* **Given** the manifest stub returns `voiceEnabled: false`
* **When** Home and `/dashboard/chat` load
* **Then** the mic button has `aria-disabled="true"`, is named "Voice is off", and shows "Voice is turned off by your administrator."; no `getUserMedia` call happens on tap
* **And** if `/api/voice/transcribe` returns `503 { "error": "voice_disabled" }` mid-session, the same disabled state appears and the recording is discarded
* **Test:** `tests/e2e/workspace/mic.spec.ts` › "admin voice off disables the mic"; `src/adapters/dashboard/voice-transcribe.test.ts` › "returns 503 voice_disabled when jarvis_voice_disabled is active or CCE_TRANSCRIBE_DISABLED=1"

### Scenario 4: Transcribe API checks caller, key and size
* **Given** the route with `transcribeAudio` mocked
* **When** it is called (a) without `chat:read`, (b) with a key outside the caller's `uploads/chat/<callerTag>/` prefix or containing `..`, (c) with a key whose object is over 2 MB or has a non-audio type, (d) twice more than the per-principal limit in one minute, (e) with a valid key
* **Then** (a) 403 `{error:'forbidden', requiredCapability:'chat:read'}`; (b) 400 `{error:'invalid_key'}` and `transcribeAudio` not called; (c) 413 `{error:'too_long'}` or 415 `{error:'unsupported_type'}`; (d) 429 `{error:'rate_limited'}`; (e) 200 `{text}` with `transcribeAudio` called once with `jobNameSuffix: 'dictation'`
* **And** the transcript text never appears in logger calls or audit rows (spy on `logger.*` and the audit writer)
* **Test:** `src/adapters/dashboard/voice-transcribe.test.ts` › "authz, caller-scoped key, size, rate limit, happy path, no transcript in logs"

### Scenario 5: Empty or failed transcript
* **Given** the transcribe stub returns `200 { "text": "" }`, or 504 `{error:'timeout'}`, or the network drops
* **When** the user stops recording
* **Then** the box is unchanged, a message reads "I couldn't hear any words. Try again closer to the mic." (empty) or "That took too long. Try again or type." (timeout or network), and the button is back to "Start speaking"
* **Test:** `tests/e2e/workspace/mic.spec.ts` › "empty or failed transcript leaves the box unchanged"; `src/lib/web-voice/dictation.test.ts` › "state machine: idle→asking→listening→thinking→idle|error|blocked|off"

### Scenario 6: Same button in chat
* **Given** `/dashboard/chat/<agentId>` with an existing draft "Hello "
* **When** the user dictates "please check this file"
* **Then** the composer reads "Hello please check this file" (inserted at the cursor), the draft is saved through `saveDraft` (`web/src/lib/chat/drafts.ts:15`), and nothing is sent
* **Test:** `tests/e2e/workspace/mic.spec.ts` › "chat composer dictation inserts at cursor"

### Scenario 7: Jarvis lives in Developer tools
* **Given** an admin principal
* **When** they open `/dashboard/` and then `/dashboard/sessions`
* **Then** on `/dashboard/` no floating orb (`[data-testid="jarvis-widget"]`, `web/src/components/JarvisWidget.tsx:264`) is rendered and no Workspace nav link points to `/jarvis`; on `/dashboard/sessions` the orb is present and the Admin rail lists "Jarvis" under "Developer tools"
* **And** `/dashboard/jarvis` still opens the orb console directly
* **Test:** `tests/e2e/workspace/mic.spec.ts` › "orb only on admin routes; /jarvis under Developer tools"

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-17 / US-017](US-017-home-animated-chat-hero-tailwind-css-port.md) Home: animated chat hero (Tailwind/CSS port) + quick actions
* **Builds on (proposed dependencies, not yet in the backlog; see NOTES):** NZR-16 (Developer tools section). Under PENDING Q100, NZR-23 (C2a slice) owns slices 1–2.
* **UI/UX Design:** design.md W-017 (mic: idle; asking for mic access; mic blocked; listening; thinking; error; voice disabled by admin) and S-011 (Jarvis → Admin > Developer tools): **NO-MOCK-YET, due Nov 23** ([design.md](../foundation/design.md)). Light mode; reduced motion: the listening pulse becomes a static ring.
* **Non-Functional Requirements:** NFR-005: button is a `<button>` with `aria-pressed` and a state-specific accessible name; state changes announced in an `aria-live="polite"` region; ≥ 56 x 56 px on Workspace (≥ 44 minimum, C-23); keyboard Space/Enter start and stop. C-02: thinking state ≤ 3 s after Stop. Max clip 60 s / 2 MB (opus at ~32 kbps ≈ 240 KB/min). Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** `voice.used` `{surface:'home'|'chat'|'describe', outcome:'inserted'|'empty'|'blocked'|'off'|'error', seconds: 0-60 rounded to 5}`. Written to the existing audit log as a separate product event type with no personal data (Q55); catalogue in OBSERVABILITY.md (NZR-44). Never the transcript, never the key. Uses US-015 `track()` (no-op until the writer exists, NOTES X2).

* **Files to change:**

| path | change |
|---|---|
| `src/adapters/dashboard/handler.ts` (next to `/chat/uploads`, `:3145-3168`) | Add `router.post('/voice/transcribe', …)`: `hasCapability(c,'chat:read')` → 403; voice-off check (`readSwitchFailClosed('jarvis_voice_disabled')` from `src/lib/jarvis/jarvis-flags.ts:51`, and `CCE_TRANSCRIBE_DISABLED==='1'`) → 503 `voice_disabled`; key must start with `chatUploadPrefix(c)` and pass `isUploadKey` (`src/lib/vectors/store.ts:124`) → else 400 `invalid_key`; HEAD the object, ≤ 2 MB and `audio/*` → else 413/415; per-principal limit (6/min) → 429; `transcribeAudio({ s3Uri: objectS3Uri(key), mimeType, jobNameSuffix: 'dictation', maxWaitMs: 30_000 })` → 200 `{text}`; on deadline → 504 `timeout`. Delete the staged object after transcription (best effort). |
| `docs/diagrams.map` | Add the new route under the dashboard handler entry (repo rule: `handler.ts` route change ⇒ map update). |
| `docs/data-flows.json` | UNVERIFIED: add the "browser dictation → S3 staging → Transcribe" flow if the file lists Transcribe flows (grep found none; check the schema). |
| `web/src/pages/Home.tsx` / `web/src/components/home/HomeHero.tsx` (US-017) | Mount `MicButton` next to Send; `onText` inserts at the cursor. |
| `web/src/components/chat/Composer.tsx` (toolbar near the attach button) | Mount `MicButton`; insert into the textarea value and call the existing input setter so `saveDraft` runs (`web/src/pages/Chat.tsx:892` pattern). |
| `web/src/App.tsx:310` | Render `<JarvisWidget />` only when `!isWorkspaceRoute(location)` (manifest helper from US-015). |
| `web/src/lib/nav/manifest.ts` | Confirm `/jarvis` is only in `ADMIN_ITEMS` section "Developer tools" (US-016) and absent from Workspace lists; test asserts it. |

* **New files:**
  * `web/src/components/MicButton.tsx` — UI for the 7 W-017 states.
  * `web/src/lib/voice/dictation.ts` — data-only state machine + plain-word messages + `pickMimeType(isTypeSupported)`; no DOM imports, so vitest can load it.
  * `web/src/lib/voice/recorder.ts` — thin `getUserMedia` + `MediaRecorder` wrapper (60 s auto-stop, tracks stopped on stop/unmount).
  * `src/adapters/dashboard/voice-transcribe.test.ts` — vitest; mock `transcribeAudio`, S3 head, kill-switch read; drive the real router like `authz-matrix.test.ts:1-22`.
  * `src/lib/web-voice/dictation.test.ts` — vitest (node) for `dictation.ts`.
  * `tests/e2e/workspace/mic.spec.ts` — Scenarios 1–3, 5–7 (US-015 config; launch args for fake media).

* **API contract:**
  * `POST /api/voice/transcribe` (Bearer token, same auth as every dashboard route). Request `application/json` `{ "key": string }` (key from `POST /api/chat/uploads`).
  * 200 `{ "text": string }` (may be `""`); 400 `{ "error": "invalid_key" }`; 403 `{ "error": "forbidden", "requiredCapability": "chat:read" }`; 413 `{ "error": "too_long", "maxBytes": 2097152 }`; 415 `{ "error": "unsupported_type" }`; 429 `{ "error": "rate_limited", "retryAfterSec": number }`; 503 `{ "error": "voice_disabled" }`; 504 `{ "error": "timeout" }`.
  * Client upload: existing `POST /api/chat/uploads` with `fileName: "dictation.webm"|"dictation.m4a"`, `mimeType: "audio/webm"|"audio/mp4"`.
* **Data changes:** No table change. Staged audio in the existing staging bucket under the caller's `uploads/chat/<callerTag>/` prefix, deleted after transcription (fallback: the staging bucket's lifecycle rule, see `infra/lib/storage-stack.test.ts:5`; UNVERIFIED expiry days). Transcribe IAM already granted (`infra/lib/iam-stack.ts:596-599`). Transcribe job named `…-dictation`. UNVERIFIED: Transcribe job output retention; check `transcriber.ts` cleanup.
* **Security notes:**
  * SECURITY.md section 6 "Authorization on the server": `chat:read` checked in the route (boundary B1).
  * Caller-scoped key: the route only accepts keys under the caller's own `chatUploadPrefix(c)` (sha256 of identity), so one user cannot transcribe another's upload (IDOR). Test (b) in Scenario 4.
  * Voice is customer data: audio and transcript stay in the customer's AWS account (S3 + Transcribe in-region); no browser `SpeechRecognition` (Chrome sends audio to Google). Transcript is not logged, not audited, not in product events (C-17).
  * Kill switch read fails closed (same helper as Jarvis); `CCE_TRANSCRIBE_DISABLED` honoured.
  * Cost (asset A8): Transcribe is billed per second; the 60 s cap + 6/min limit bound spend. UNVERIFIED: whether dictation should also count against the daily cost cap (`src/adapters/dashboard/cost-cap.ts`); ask the critic.
  * Browser: mic only after a user tap; tracks stopped on stop, unmount and route change.
* **Test plan:**
  * Frozen failing tests first: `src/adapters/dashboard/voice-transcribe.test.ts`, `src/lib/web-voice/dictation.test.ts`, then `tests/e2e/workspace/mic.spec.ts`.
  * Fixtures: fake media device (Chromium flags); synthetic transcript strings; transcribe route stubbed in e2e; `transcribeAudio` mocked in vitest. No real AWS call in any test.
  * Manual (owner demo, not a gate): one real dictation on a local stack only if Transcribe is reachable; LocalStack/Floci Transcribe support is UNVERIFIED, so the gate does not depend on it.
  * Commands: `npx vitest run src/adapters/dashboard/voice-transcribe.test.ts src/lib/web-voice/`; `npm test`; `npm run typecheck`; `npm --prefix web run typecheck`; `npm --prefix web run build`; `npx playwright test --config tests/e2e/workspace/playwright.config.ts mic.spec.ts`; `node scripts/ci/secret-scan.mjs <changed files>`.
* **Repo rules that apply:** `handler.ts` route change ⇒ `docs/diagrams.map` update in the same commit (CONTRIBUTING.md). No new dependency (MediaRecorder is a browser API). Nav sync unchanged except `/jarvis` placement (manifest + drift test). Feature HANDOFF + dated session handoff.
* **Rollback:** Revert the merge. Or switch voice off without a deploy: activate kill switch `jarvis_voice_disabled` (the button shows "Voice is off"; typing works). Orphan staged audio expires under the bucket lifecycle.
* **Build slices (proposal):**
  1. **Transcribe route** (~1.5 h): handler route + map + `voice-transcribe.test.ts`. Green: Scenarios 3 (API part), 4. *(C2a slice under Q100.)*
  2. **Mic component** (~1.5 h): `dictation.ts`, `recorder.ts`, `MicButton.tsx`. Green: `dictation.test.ts`; Scenarios 2, 5. *(C2a slice under Q100.)*
  3. **Home + chat placement** (~1 h): mount in hero and composer. Green: Scenarios 1, 3 (UI), 6.
  4. **Jarvis move** (~0.5 h): App widget rule, manifest assertion. Green: Scenario 7.
* **Agent gotchas:**
  * Safari has no `audio/webm`; use `audio/mp4` and file name `.m4a` so `audioMimeFor`-style mapping and `chatAttachmentFormat` (`src/lib/chat/attachments.ts:13-22`) accept it.
  * `transcribeAudio` polls up to 60 s by default (`transcriber.ts:29`); pass a 30 s `maxWaitMs` so the request ends before CloudFront/API timeouts. UNVERIFIED: the dashboard request timeout.
  * Do not reuse `voiceClient`: it opens the Jarvis WebSocket and plays audio. Only copy its permission handling (`voiceClient.ts:181-197`).
  * The Jarvis mic signal `jarvisMicPermission` is global; the new button keeps its own state so a blocked Jarvis mic does not mislabel the dictation button (and vice versa).
  * `JarvisWidget` reads `jarvisWidgetHidden` and positions from the sidebar DOM (`JarvisWidget.tsx:66-100`); hiding it on Workspace routes must not clear that stored preference.
  * `JarvisWidget` already uses `data-testid="mic-button"` (`JarvisWidget.tsx:283`) and existing Jarvis e2e specs may select it. Give the new button `data-testid="dictation-mic"`.
  * Playwright fake-media flags only work in Chromium; the iPad/Safari path is a manual check in the owner demo.

---

## 5. Estimation & Tracking
* **Epic Name:** M2b Workspace + testers (cycle C2b Workspace + Admin console + testers, 2026-11-24 to 2026-12-07)
* **Priority:** Could Have
* **Story Points / Effort Estimate:** 3 (raw estimate 3 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T2 · **Deploy reach:** local only · **Labels:** ui, cut-4

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases (blocked, missing API, admin off, empty, timeout, foreign key, rate limit).
- [ ] UX/UI designs are attached and finalized: design.md W-017 and the S-011 move are **NO-MOCK-YET, due Nov 23** (MOCK screenshots; NO-MOCK-YET entries must be mocked before the step starts, Q77).
- [ ] Dependencies have been identified and are unblocked (proposed extras marked in section 4; NZR-17; NZR-16; owner answer on Q100 decides whether slices 1–2 already exist).
- [ ] Owner agrees: new server route (T2 critic reviews it) and hiding the floating orb on Workspace routes.
- [ ] The team has reviewed and estimated the story points (3 pts; re-checked at the Nov 9 re-plan, Q71; NOTES proposes 5, or 3 if Q100 moves slices 1–2).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] **Story exit gate (owner rule, all four required on the exact HEAD, evidence block recorded):** (1) code review: fresh critic, findings fixed or owner-waived; (2) unit tests: red SHA then green, full suite + typecheck; (3) UAT: every Given/When/Then scenario marked PASS and accepted; (4) E2E: run through the real entry point, happy + main failure path (or `N/A: reason` for docs/owner tasks). See [story-exit-gate](../story-exit-gate.md). Lessons in [LESSONS.md](../LESSONS.md) checked before PLANNING; any failure adds an entry with a guard. `PENDING` only for a gate needing an environment that does not exist yet (story is then Done locally).
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail).
- [ ] Peer code review is completed and approved. T2: fresh Claude critic + free checks (npm audit, `node scripts/ci/secret-scan.mjs <changed files>`, typecheck) + step maid (Q68). Critic checks the caller-scoped key rule and that no transcript is logged.
- [ ] A frozen failing test came first (red SHA recorded); the gate is green on a clean checkout of the exact HEAD: `npx vitest run src/adapters/dashboard/voice-transcribe.test.ts src/lib/web-voice/` and `npx playwright test --config tests/e2e/workspace/playwright.config.ts mic.spec.ts`; full `npm test` green.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: the owner accepts a short demo (Q51): dictate on Home and in chat, blocked mic, admin voice off.
- [ ] Documentation is updated: `docs/diagrams.map`, feature HANDOFF + a dated session handoff; the dictation API and the "insert, never send" rule promoted to README/ADR.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: PENDING until NZR-42 (AWS account) exists.
