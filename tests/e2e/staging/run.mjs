// Live staging verification for Netzar Chat: the things a local Bedrock stub can never prove — a
// real sign-in, the roll-call from real Bedrock, genuine streaming cadence, and a live tool round.
//
//   STAGING_TOKEN=<token> node tests/e2e/staging/run.mjs
//
// This targets the DEPLOYED staging dashboard and spends real Bedrock money, so it is deliberately
// NOT wired into CI (owner decision 38) and every run is authorized separately (owner decision 6).
// The token is read from the environment only and is never printed, logged or written to a file.
//
// Shape follows the sibling deployed-URL suites tests/e2e/{cost,iam}/run.mjs: raw playwright,
// env-supplied token, rec()/SUMMARY, non-zero exit on failure. It adds one thing they do not have,
// a VERIFY.json, because the scorecard has to survive the run to be read afterwards.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const BASE = process.env.STAGING_BASE ?? 'https://staging.pgnos.ai';
const TOKEN = process.env.STAGING_TOKEN ?? '';
const dir = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
const OUT = `${dir}/out`;

const SURFACES = [
  ['light', { width: 1280, height: 800 }, 'light-desktop'],
  ['dark', { width: 1280, height: 800 }, 'dark-desktop'],
  ['light', { width: 375, height: 812 }, 'light-mobile'],
  ['dark', { width: 375, height: 812 }, 'dark-mobile'],
];
// The turn-level observations are made once, on the first surface, because each costs a real
// Bedrock turn. The other surfaces exist for the theme screenshot.
const PRIMARY = 'light-desktop';

// One prompt has to satisfy TWO checks at once, and the first version satisfied only one.
//
// It must DISPATCH A TOOL: "List three things you can help with" dispatches none, so a live tool
// status could never be observed however good the rest of the harness was. get_time is a built-in
// registered for EVERY agent (src/lib/tools/builtin-tools.ts) and is side-effect free — it formats
// new Date() through Intl.DateTimeFormat, makes no AWS call and touches no infrastructure — so it
// costs nothing beyond the turn itself.
//
// It must ALSO PRODUCE A REPLY LONG ENOUGH TO WATCH ARRIVE, and that is what the first authorized
// staging run found the hard way. "What time is it?" answers in one sentence: the real run returned
// 61 characters in a 5.6s turn, the live answer node appeared and committed inside roughly one
// sampling tick, and the cadence check scored 0 growth frames. It was not that staging failed to
// stream — the instrument could not observe it either way. Optimising for the cheap tool call had
// designed the streaming check out of its own prompt.
//
// So the prompt now asks for both: the tool AND a reply with enough words to span many samples.
// It stays one turn and one model call pair; the only cost is a few more output tokens.
const TOOL_PROMPT =
  'Use the get_time tool to get the current time in America/New_York, then tell me the time.';

// A SECOND prompt, and it has to be a second TURN. The two checks are mutually exclusive on one
// turn, which the first two authorized staging runs proved at a cost of $0.08 between them:
//
//   agent-loop.ts makes its INITIAL model call through converseStreamTurnWithFallback, which
//   streams. But once a tool runs, the follow-up that actually writes the answer is a plain
//   `new ConverseCommand(...)` with no onChunk and no streaming path at all. So ANY turn that
//   dispatches a tool returns its reply WHOLE. A prompt guaranteeing a tool round guarantees a
//   non-streaming answer, and no amount of faster sampling can see a stream that is not sent.
//
// That is a real product observation, recorded and NOT patched here: making the synthesis round
// stream is a change to the agent loop, which is P2 (turn lifecycle) work, not this harness's.
// So the tool check gets its own turn, and cadence gets a turn with NO tool in it.
//
// AND THEN THE TOOL-FREE TURN DID NOT STREAM EITHER. Measured on staging 2026-09-22 with a DOM
// probe sampling every 250ms for 40s on a turn with no tool in it at all:
//   .chat-streaming existed in 0 of 160 samples
//   the composer stayed disabled for 26 samples = 6.5s, so the turn really was in flight
//   at sample 26 the answer appeared FULLY FORMED at 995 characters, in one step, already
//   committed to a .chat-md node — no intermediate state ever existed
// So the deployed staging dashboard does not stream replies to the browser AT ALL. The cadence
// check is therefore CORRECT and is reporting a true negative; it is not a harness defect and it
// must NOT be weakened to make the scorecard green. Making a check pass by lowering its bar is the
// one change that would destroy the only thing this tier is for.
// Routed to P2 (turn lifecycle). Until the product streams, F1_TIER=staging tops out at 11 of 12,
// and that number is the honest one.
const CADENCE_PROMPT =
  'Without using any tools, write about 150 words on why clear written handovers matter when ' +
  'several engineers work on the same system.';

// Every check this run is required to report on. Each is SEEDED as failed, then overwritten on a
// real result, so a run that dies early still records what it never reached instead of silently
// omitting the key. A missing key and a failed key are not the same statement, and a reader must be
// able to tell "we tried and it failed" from "we never tried".
const REQUIRED_CHECKS = [
  'staging responds',
  ...SURFACES.map(([, , tag]) => `sign in (${tag})`),
  'roll-call: API reachable on staging',
  'streaming cadence (real Bedrock)',
  'live tool status',
  ...SURFACES.map(([, , tag]) => `theme renders (${tag})`),
];
// The seeded verdict, carried by a check nothing has observed yet. recIfUnreached() tests for
// exactly this string to decide whether a verdict is still up for grabs, so it must never be passed
// to rec() as a real detail — naming it once is what keeps those two places from drifting apart.
const NOT_REACHED = 'not reached';
const results = new Map(
  REQUIRED_CHECKS.map((name) => [name, { name, pass: false, detail: NOT_REACHED }]),
);
function rec(name, pass, detail) {
  if (!results.has(name)) throw new Error(`undeclared check: ${name}`);
  results.set(name, { name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} :: ${detail}`);
}
// Used when a surface throws: fill in the real reason for anything that never got a verdict,
// without overwriting a verdict already reached honestly.
function recIfUnreached(name, detail) {
  if (results.get(name)?.detail === NOT_REACHED) rec(name, false, detail);
}

// The live tool line is an EDGE, not a level: StreamingRow renders it only while toolStatus is
// non-empty, and streamTurn clears it the moment the first chunk lands. Sampling the DOM on a timer
// can step straight over a whole tool round. Subscribe instead — this runs before any page script,
// on every navigation, and accumulates every tool status the page ever shows.
function installToolStatusObserver(ctx) {
  return ctx.addInitScript(() => {
    window.__toolStatusSeen = [];
    const sweep = () => {
      for (const el of document.querySelectorAll('[data-chat-tool-status]')) {
        const text = (el.textContent ?? '').trim();
        if (text && !window.__toolStatusSeen.includes(text)) window.__toolStatusSeen.push(text);
      }
    };
    const start = () => {
      sweep();
      new MutationObserver(sweep).observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    };
    if (document.documentElement) start();
    else document.addEventListener('DOMContentLoaded', start);
  });
}

async function signIn(page) {
  await page.goto(`${BASE}/dashboard/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  if (!TOKEN) return 'no STAGING_TOKEN in the environment';
  const toggle = page.locator('text=/sign in with a dashboard token/i').first();
  if (await toggle.count()) await toggle.click();
  const input = page.locator('input[type="password"], input[placeholder*="token" i]').first();
  if (!(await input.count())) return 'token field not found on the sign-in screen';
  await input.fill(TOKEN);
  await page.locator('button:has-text("Sign in")').last().click();
  // This SPA has NO /login route. AuthGate renders <Login/> in place at the same URL
  // (web/src/App.tsx), and a rejected token only sets local error state
  // (web/src/pages/Login.tsx) — neither path navigates. So testing page.url() for '/login'
  // can never observe a rejection: it would report a signed-in dashboard for ANY token,
  // including a wrong one. Observe the screen instead. The token field leaving the DOM is a
  // positive, authenticated-only signal, because only AuthGate swapping Login out removes it.
  const signedIn = await input
    .waitFor({ state: 'detached', timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  if (signedIn) return null;
  const shown = await page
    .locator('text=/invalid token|server unreachable|unable to connect/i')
    .first()
    .textContent()
    .catch(() => null);
  return shown
    ? `token rejected: ${shown.trim()}`
    : 'still on the sign-in screen after submitting the token';
}

const browser = await chromium.launch();
try {
  fs.mkdirSync(OUT, { recursive: true });

  // 0. The app is served at all.
  const probe = await browser.newContext();
  const resp = await probe
    .newPage()
    .then((p) => p.goto(`${BASE}/dashboard/`, { waitUntil: 'domcontentloaded' }))
    .catch(() => null);
  rec('staging responds', !!resp && resp.status() < 400, `HTTP ${resp ? resp.status() : 'no response'}`);
  await probe.close();

  for (const [theme, viewport, tag] of SURFACES) {
    const ctx = await browser.newContext({ viewport });
    // Each surface is isolated: a navigation error on one must not abandon the other three. A
    // Layer B run is authorized and paid for one turn at a time, so losing the whole run to a
    // single transient error is not acceptable.
    try {
      // A fresh browser profile has empty localStorage, and App.tsx redirects to
      // /getting-started whenever neither onboarding key is set — regardless of the URL asked
      // for. Every automated run is a fresh profile by design, so WITHOUT THIS every deep link
      // into the dashboard lands on the onboarding checklist instead of its target. Found by the
      // first real staging run: sign-in and the roll-call passed, and the chat checks were never
      // reached because the page was never chat. The key is the one GettingStarted.tsx exports.
      await ctx.addInitScript((t) => {
        localStorage.setItem('cce_theme', t);
        localStorage.setItem('cce_company_onboarding_seen', '1');
      }, theme);
      await installToolStatusObserver(ctx);
      const page = await ctx.newPage();
      // tests/e2e/cost/run.mjs:23 and tests/e2e/iam/run.mjs:28 both raise this. A deployed staging
      // host is hit infrequently and talks to DynamoDB and Bedrock, so a cold start past
      // Playwright's bare 30s default is realistic — and on the PRIMARY surface it would mark four
      // checks failed for a reason that is the clock, not the deployment.
      page.setDefaultTimeout(45_000);
      page.setDefaultNavigationTimeout(60_000);

      const failure = await signIn(page);
      rec(`sign in (${tag})`, !failure, failure ?? 'signed in with the dashboard token');
      if (failure) {
        if (tag === PRIMARY) {
          const why = `primary surface never signed in: ${failure}`;
          rec('roll-call: API reachable on staging', false, why);
          rec('streaming cadence (real Bedrock)', false, why);
          rec('live tool status', false, why);
        }
        continue;
      }

      await page.goto(`${BASE}/dashboard/chat`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      await page.screenshot({ path: `${OUT}/${tag}-landing.png` }).catch(() => {});

      // 1. ROLL-CALL against real Bedrock. The dashboard has no cookie auth at all —
      // web/src/lib/api.ts sends `Authorization: Bearer ${getToken()}` on every call, and a
      // `cookie` grep over src/adapters/dashboard/handler.ts finds nothing — so an in-page
      // cookie-bearing fetch always 401s. Send the bearer the way tests/e2e/cost/run.mjs does.
      if (tag === PRIMARY) {
        const headers = { Authorization: `Bearer ${TOKEN}` };
        const [agentsRes, modelsRes] = await Promise.all([
          page.request.get(`${BASE}/api/agents`, { headers }),
          page.request.get(`${BASE}/api/models`, { headers }),
        ]);
        const agentsBody = agentsRes.ok() ? await agentsRes.json().catch(() => null) : null;
        const modelsBody = modelsRes.ok() ? await modelsRes.json().catch(() => null) : null;
        const activeAgents = (agentsBody?.agents ?? []).filter((a) => a.status === 'active').length;
        const modelCount = (modelsBody?.models ?? []).length;
        rec(
          'roll-call: API reachable on staging',
          activeAgents > 0 && modelCount > 0,
          `${activeAgents} active agents, ${modelCount} models from real Bedrock ` +
            `(HTTP ${agentsRes.status()}/${modelsRes.status()})`,
        );
      }

      // 2. STREAMING CADENCE and 3. LIVE TOOL STATUS, from one real agent turn.
      const box = page.locator('textarea, [contenteditable="true"]').first();
      if (await box.count()) {
        // The composer is disabled while a turn is in flight (Composer.tsx `disabled={streaming}`),
        // so that is the product's own "am I finished" signal. Using it beats a fixed sleep: it is
        // exact, and it comes from the thing being tested rather than from a guess about timing.
        const turnSettled = () =>
          page
            .waitForFunction(
              () => {
                const t = document.querySelector('textarea');
                return !!t && !t.disabled;
              },
              { timeout: 120_000 },
            )
            .catch(() => {});

        const send = async (text) => {
          await turnSettled();
          await box.click();
          await box.fill(text);
          await page.keyboard.press('Enter');
        };

        await send(TOOL_PROMPT);
        if (tag === PRIMARY) {
          // TURN 1 — the tool round. Its answer does not stream (see CADENCE_PROMPT), so there is
          // nothing to sample here; just let it finish and read what the observer accumulated.
          await turnSettled();
          const seenTools = await page.evaluate(() => window.__toolStatusSeen ?? []);
          rec(
            'live tool status',
            seenTools.length > 0,
            seenTools.length
              ? `observed: ${[...new Set(seenTools)].slice(0, 3).join(' | ')}`
              : 'none observed across the whole turn, with the prompt asking for get_time',
          );

          // TURN 2 — cadence, on a prompt that dispatches NO tool, so the reply comes back through
          // the streaming path.
          await send(CADENCE_PROMPT);
          const started = Date.now();
          // Cadence is a level, so sampling is the right instrument for it — but the window has
          // to cover BOTH Bedrock round-trips a tool turn needs (the call that decides to use
          // get_time, then the call that writes the answer once the tool result is appended)
          // before the reply it measures even begins. The archived harness budgeted 20s for a
          // prompt that dispatched no tool at all. Only this surface is scored, so only this
          // surface pays for the long window.
          // 250ms, not 500: the first real run's reply committed inside roughly one 500ms tick,
          // so the sampler never saw it. Halving the interval doubles the chance of catching a
          // short reply, and costs nothing — the samples are DOM reads against a page already open.
          const SAMPLE_MS = 250;
          // The window is a CEILING, not a duration. The first run held it for the full 60s after a
          // turn that finished in 5.6s, which is 55 wasted seconds per run and why a 12-check run
          // took 113s. It now stops as soon as the turn commits (below), so the ceiling only binds
          // when something is genuinely wrong — which is exactly when you want to wait.
          const WINDOW_MS = 60_000;
          const frames = [];
          let seenAnswer = false;
          for (let i = 0; i < WINDOW_MS / SAMPLE_MS; i++) {
            await page.waitForTimeout(SAMPLE_MS);
            const len =
              await page.evaluate(() => {
                // Measure the streaming ANSWER node only. The transcript container
                // ([data-tour="chat-messages"]) also holds LiveFooter's elapsed-seconds
                // counter, which is a plain setInterval on the client's wall clock
                // (StreamingRow.tsx) and gains a character at the 9s->10s boundary whether or
                // not the server sent a byte, and the tool-status line, which this prompt
                // guarantees will appear. Counting either as "growth" would let a single-shot
                // response score as genuine streaming — the one thing this check exists to
                // rule out. .chat-streaming is the live answer markdown and nothing else.
                const el = document.querySelector('.chat-streaming');
                return el ? el.innerText.length : 0;
              });
            frames.push(len);
            // .chat-streaming exists ONLY while the turn is streaming, so the series runs
            // 0 … N1 < N2 < … then back to 0 when the reply commits to the transcript. Once we
            // have seen it non-empty and it has gone again, the turn is over and every further
            // sample is a zero that tells us nothing. Stop there.
            if (len > 0) seenAnswer = true;
            else if (seenAnswer) break;
          }
          const growth = frames.filter((v, i) => i > 0 && v > frames[i - 1]).length;
          rec(
            'streaming cadence (real Bedrock)',
            growth >= 3,
            `${growth} growth frames over ${Math.round((Date.now() - started) / 1000)}s on a ` +
              'TOOL-FREE turn — a stub emits one chunk, so >2 proves genuine streaming',
          );
        } else {
          // This surface is here for the theme screenshot, not for a measurement.
          await page.waitForTimeout(8_000);
        }
        await page.screenshot({ path: `${OUT}/${tag}-conversation.png` }).catch(() => {});
      } else if (tag === PRIMARY) {
        // No composer means the turn was never sent, so both turn checks would otherwise keep
        // their seeded 'not reached' and say nothing about WHY. That is the same defect class the
        // required-check seeding exists to close, surviving in a second place: a skip that records
        // nothing is indistinguishable from a crash. Name the reason and the page we were actually
        // on — on the first real staging run that page was the onboarding checklist, and the URL
        // is what would have said so immediately.
        const why = `composer not found on ${page.url()} — the turn was never sent`;
        rec('streaming cadence (real Bedrock)', false, why);
        rec('live tool status', false, why);
      }

      // 4. THEME rendered, at this breakpoint.
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      rec(`theme renders (${tag})`, !!bg && bg !== 'rgba(0, 0, 0, 0)', `body background ${bg}`);
    } catch (err) {
      const why = (err instanceof Error ? err.message : String(err)).split('\n')[0];
      recIfUnreached(`sign in (${tag})`, why);
      recIfUnreached(`theme renders (${tag})`, why);
      if (tag === PRIMARY) {
        recIfUnreached('roll-call: API reachable on staging', why);
        recIfUnreached('streaming cadence (real Bedrock)', why);
        recIfUnreached('live tool status', why);
      }
    } finally {
      await ctx.close();
    }
  }
} catch (err) {
  console.error('STAGING_VERIFY_ERROR', err instanceof Error ? err.message : String(err));
} finally {
  await browser.close();
  const all = REQUIRED_CHECKS.map((name) => results.get(name));
  fs.writeFileSync(`${OUT}/VERIFY.json`, JSON.stringify(all, null, 2));
  const failed = all.filter((r) => !r.pass);
  console.log(
    `\n${failed.length === 0 ? 'STAGING_VERIFY_PASS' : 'STAGING_VERIFY_FAIL'} ` +
      `${all.length - failed.length}/${all.length}`,
  );
  failed.forEach((f) => console.log(`  FAILED: ${f.name} :: ${f.detail}`));
  process.exit(failed.length === 0 ? 0 : 1);
}
