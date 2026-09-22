// Live staging verification for Netzar Chat: the things a local Bedrock stub can
// never prove — a real sign-in, the roll-call from real Bedrock, genuine
// streaming cadence, and a live tool round.
//
//   STAGING_TOKEN=<token> node tests/e2e/staging/run.mjs
//
// This targets the DEPLOYED staging dashboard and spends real Bedrock money, so
// it is deliberately NOT wired into CI (owner decision 38) and every run is
// authorized separately (owner decision 6). The token is read from the
// environment only and is never printed, logged or written to a file.
//
// Shape follows the sibling deployed-URL suites tests/e2e/{cost,iam}/run.mjs:
// raw playwright, env-supplied token, rec()/SUMMARY, non-zero exit on failure.
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
// The turn-level observations are made once, on the first surface, because each
// one costs a real Bedrock turn.
const PRIMARY = 'light-desktop';

// A prompt that actually dispatches a tool. "List three things you can help
// with" dispatches none, so a live tool status could never be observed however
// good the rest of the harness was. get_time is a built-in registered for EVERY
// agent (src/lib/tools/builtin-tools.ts) and is side-effect free: it formats
// new Date() through Intl.DateTimeFormat, makes no AWS call and touches no
// infrastructure, so it costs nothing beyond the turn itself.
const TOOL_PROMPT = 'What time is it right now in America/New_York? Use the get_time tool.';

// Every check this run is required to report on. Each is SEEDED as failed, then
// overwritten on a real result, so a run that dies early still records what it
// never reached instead of silently omitting the key. A missing key and a
// failed key are not the same statement, and a reader must be able to tell
// "we tried and it failed" from "we never tried".
const REQUIRED_CHECKS = [
  'staging responds',
  ...SURFACES.map(([, , tag]) => `sign in (${tag})`),
  'roll-call: API reachable on staging',
  'streaming cadence (real Bedrock)',
  'live tool status',
  ...SURFACES.map(([, , tag]) => `theme renders (${tag})`),
];
const results = new Map(
  REQUIRED_CHECKS.map((name) => [name, { name, pass: false, detail: 'not reached' }]),
);
function rec(name, pass, detail) {
  if (!results.has(name)) throw new Error(`undeclared check: ${name}`);
  results.set(name, { name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} :: ${detail}`);
}
// Used when a surface throws: fill in the real reason for anything that never
// got a verdict, without overwriting a verdict already reached honestly.
function recIfUnreached(name, detail) {
  if (results.get(name)?.detail === 'not reached') rec(name, false, detail);
}

// The live tool line is an EDGE, not a level: StreamingRow renders it only while
// toolStatus is non-empty, and streamTurn clears it the moment the first chunk
// lands. Sampling the DOM on a timer can step straight over a whole tool round.
// Subscribe instead — this runs before any page script, on every navigation, and
// accumulates every tool status the page ever shows.
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
  await page.waitForTimeout(4000);
  return /\/login/.test(page.url()) ? 'still on /login after submitting the token' : null;
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
    // Each surface is isolated: a navigation error on one must not abandon the
    // other three. A Layer B run is authorized and paid for one turn at a time,
    // so losing the whole run to a single transient error is not acceptable.
    try {
    await ctx.addInitScript((t) => localStorage.setItem('cce_theme', t), theme);
    await installToolStatusObserver(ctx);
    const page = await ctx.newPage();

    const failure = await signIn(page);
    rec(`sign in (${tag})`, !failure, failure ?? 'signed in with the dashboard token');
    if (failure) {
      if (tag === PRIMARY) {
        const why = `primary surface never signed in: ${failure}`;
        rec('roll-call: API reachable on staging', false, why);
        rec('streaming cadence (real Bedrock)', false, why);
        rec('live tool status', false, why);
      }
      await ctx.close();
      continue;
    }

    await page.goto(`${BASE}/dashboard/chat`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${OUT}/${tag}-landing.png` });

    // 1. ROLL-CALL against real Bedrock. The dashboard has no cookie auth at
    // all — web/src/lib/api.ts sends `Authorization: Bearer ${getToken()}` on
    // every call, and a `cookie` grep over src/adapters/dashboard/handler.ts
    // finds nothing — so an in-page cookie-bearing fetch always 401s. Send the
    // bearer the way tests/e2e/cost/run.mjs already does.
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
      await box.click();
      await box.fill(TOOL_PROMPT);
      const frames = [];
      const started = Date.now();
      await page.keyboard.press('Enter');
      // Cadence is a level, so sampling is the right instrument for it.
      for (let i = 0; i < 40; i++) {
        await page.waitForTimeout(500);
        frames.push(
          await page.evaluate(() => {
            const el = document.querySelector('[data-tour="chat-messages"]');
            return el ? el.innerText.length : 0;
          }),
        );
      }
      const seenTools = await page.evaluate(() => window.__toolStatusSeen ?? []);
      if (tag === PRIMARY) {
        const growth = frames.filter((v, i) => i > 0 && v > frames[i - 1]).length;
        rec(
          'streaming cadence (real Bedrock)',
          growth >= 3,
          `${growth} growth frames over ${Math.round((Date.now() - started) / 1000)}s — ` +
            'a stub emits one chunk, so >2 proves genuine streaming',
        );
        rec(
          'live tool status',
          seenTools.length > 0,
          seenTools.length
            ? `observed: ${[...new Set(seenTools)].slice(0, 3).join(' | ')}`
            : 'none observed across the whole turn, with the prompt asking for get_time',
        );
      }
      await page.screenshot({ path: `${OUT}/${tag}-conversation.png` });
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
