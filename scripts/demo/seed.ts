/**
 * `tsx scripts/demo/seed.ts --env=demo` - stand up the public demo instance.
 *
 * Idempotent. Three phases, each safe to re-run:
 *   1. Fleet     - create (from the gallery templates) and activate the six
 *                  creator/SMB agents that tell the "small team" story.
 *   2. Knowledge - ingest a synthetic business ("Beacon") so the grounded
 *                  agents have real docs to cite. Fixed docIds, so re-ingest
 *                  updates in place instead of duplicating.
 *   3. Lockdown  - clamp the demo so a stranger cannot run up a bill or reach
 *                  the outside world: low daily cap, paid/outbound tools off,
 *                  guardrail + PII redaction on.
 *
 * This targets whatever deployment the --env file points at. NEVER run it
 * against prod (--env defaults to prod): point it at a dedicated demo stack
 * with `--env=demo` and a `.env.demo` file. scripts/demo/reset.ts re-runs
 * runDemoSeed() nightly after wiping ephemeral state.
 *
 * Usage:
 *   tsx scripts/demo/seed.ts --env=demo
 *   tsx scripts/demo/seed.ts --env=demo --json
 */

import { bold, dim, fail, ok } from '../lib/ansi.js';
import { bootstrapDemoEnv } from './env.js';
import type { KillSwitchName } from '../../src/lib/state/kill-switches-repo.js';

/** The six agents the demo seeds and the reset job preserves. */
export const SEED_AGENT_IDS = [
  'support',
  'sdr',
  'social',
  'marketing-strategist',
  'community-manager',
  'bookkeeper',
] as const;

/**
 * Demo lockdown. Editable in one place so the operator can see exactly what a
 * visitor can and cannot do. Switches set `active: true` BLOCK the behavior
 * (that is the kill-switch contract); `active: false` ensures it is allowed.
 */
const LOCKDOWN = {
  config: [
    // A demo-sized daily Bedrock cap that fails closed. This is the load-bearing
    // guard against a shared, public token running up the bill.
    { category: 'cost', key: 'daily_cap_usd', value: '25' },
    // Never let the demo apply IAM changes (also the prod default; asserted here).
    { category: 'iam', key: 'apply_enabled', value: 'false' },
  ],
  // Block: paid add-ons and every outbound channel, so a scheduled task or a
  // curious visitor cannot spend or message a real person.
  block: [
    'image_gen_disabled',
    'tts_disabled',
    'email_send_disabled',
    'document_gen_disabled',
    'web_search_disabled',
    'telegram_posting',
    'slack_posting',
  ] as KillSwitchName[],
  // Ensure on: guardrail attached (prod runs it off for War Room; for a public
  // demo we want it on, so test the War Room path before launch), PII redaction.
  ensureOn: ['pii_redaction_enabled'] as KillSwitchName[],
  // Ensure off: the core loop must still work for visitors.
  ensureOff: ['guardrail_disabled', 'tool_use', 'dashboard_read_disabled'] as KillSwitchName[],
};

/**
 * Synthetic knowledge for a fictional creator business "Beacon" (an online
 * course + paid community + coaching offer). Scopes line up with each agent's
 * suggestedKnowledgeScope so retrieval lands. Content is invented; no real PII.
 */
const DEMO_DOCS: Array<{
  scope: string;
  docId: string;
  docTitle: string;
  tags: string[];
  content: string;
}> = [
  {
    scope: 'support',
    docId: 'demo-support-billing',
    docTitle: 'Beacon Help Center - Billing, Plans & Refunds',
    tags: ['billing', 'refunds', 'pricing'],
    content: `# Billing, Plans & Refunds

## Plans
- The Beacon Course is a one-time purchase of $499 and includes lifetime access.
- The Beacon Community membership is $39 per month, billed on the day you joined, cancel anytime.
- 1:1 Coaching is $1,500 for a six-week engagement, paid up front.

## Refunds
- Course: full refund within 14 days of purchase, no questions asked. After 14 days the sale is final.
- Community: no refunds on a billed month, but you can cancel before the next renewal and keep access until the period ends.
- Coaching: refundable up until the first session. After the first session it is non-refundable.

## Common billing issues
- Double charge: confirm whether the two charges are the course and the community (those are separate products) before treating it as a duplicate. If both charges are the same product on the same day, it is a duplicate; apologize, refund one, and confirm by email.
- Update a card: Account, then Billing, then Payment method.
- Failed renewal: the membership retries for three days, then access pauses until the card is updated.`,
  },
  {
    scope: 'support',
    docId: 'demo-support-access',
    docTitle: 'Beacon Help Center - Getting Started & Access',
    tags: ['access', 'login', 'onboarding'],
    content: `# Getting Started & Access

## After you buy the course
You get an email within a few minutes with your login link. The course lives at app.beacon.example. If the email did not arrive, check spam, then confirm the purchase email address.

## Logging in
Beacon uses a passwordless magic link. Enter your email, click the link, done. Links expire after 15 minutes; request a fresh one if it fails.

## Where the community lives
The paid community is a separate space at community.beacon.example. Your course login does not automatically grant community access; the membership is its own product.

## Resetting access
There is no password to reset. If a member cannot get in, confirm the email on file matches the one they are typing, then send a fresh magic link.`,
  },
  {
    scope: 'community',
    docId: 'demo-community-guidelines',
    docTitle: 'Beacon Community - Welcome & Guidelines',
    tags: ['community', 'guidelines', 'welcome'],
    content: `# Welcome to the Beacon Community

This is a paid space for people building a creator business. Be useful, be specific, skip the self-promotion.

## How to start
Post a short intro in Introductions: what you are building, where you are stuck, what you want from the next month.

## Channels
- Wins: share a result, big or small.
- Help: ask a specific question, include what you have already tried.
- Resources: drop a tool or template, one per post.

## Weekly rhythm
- Monday: a goal thread.
- Thursday: a live office-hours call.
- Friday: a wins roundup.

## Norms
No DMs pitching members. No affiliate links in Resources. If someone is rude or spamming, flag it for a human moderator rather than engaging.

## At-risk signals
A member who introduced themselves and then went silent for two weeks, or one posting cancel-leaning language, should get a warm, specific check-in, never a guilt trip.`,
  },
  {
    scope: 'sales',
    docId: 'demo-sales-onepager',
    docTitle: 'Beacon Coaching - Offer One-Pager & Pricing',
    tags: ['coaching', 'sales', 'qualification'],
    content: `# Beacon Coaching - One-Pager

## Who it is for
Creators who already have an audience or a product and want a focused six weeks to ship a specific outcome (a launch, a new offer, a content system).

## What is included
Six weekly 1:1 sessions, async review between sessions, and a written plan you keep. Price is $1,500, paid up front.

## Who it is NOT for
Total beginners with no audience and no offer yet (the course is the right first step), and anyone looking for done-for-you work. Coaching is guidance, not delivery.

## Qualification
A good fit can answer: what are you building, what is the one outcome for the six weeks, and can you commit two to three hours a week. If budget is a hard no, point them to the course or community instead of pushing.`,
  },
  {
    scope: 'finances',
    docId: 'demo-finances-coa',
    docTitle: 'Beacon Bookkeeping - Chart of Accounts & Sample Month',
    tags: ['bookkeeping', 'accounts', 'finance'],
    content: `# Chart of Accounts & Sample Month

Fiscal year is the calendar year. All figures in USD.

## Revenue accounts
- Course Sales
- Community Subscriptions
- Coaching

## Expense accounts
- Software (hosting, email, community platform)
- Contractors (editor, designer)
- Advertising
- Payment Processing Fees

## Sample month (illustrative)
- Course Sales: $4,990 (10 sales)
- Community Subscriptions: $3,510 (90 active members)
- Coaching: $3,000 (2 engagements)
- Software: $620
- Contractors: $1,400
- Advertising: $900
- Payment Processing Fees: $340

Net before owner pay and taxes is roughly $11,500 in, $3,260 out. Categorize every transaction to one account above; if a charge does not fit, flag it rather than forcing it.`,
  },
  {
    scope: 'default',
    docId: 'demo-brand-voice',
    docTitle: 'Beacon Brand - Positioning & Voice',
    tags: ['brand', 'positioning', 'voice'],
    content: `# Beacon - Positioning & Voice

## Who we serve
Creators going from "I post content" to "I run a business." They are capable and busy, and they distrust hype.

## The promise
A clear path and a small set of tools to turn an audience into durable revenue, without a 40-step funnel.

## The offer ladder
Free content brings people in, the $499 course teaches the system, the $39/mo community keeps them accountable, and coaching is for the few who want hands-on guidance.

## Voice
Direct and concrete. Lead with the point. No "unlock your potential," no "game-changer," no fake urgency. Show the receipts, name the tradeoff, respect the reader's time.`,
  },
];

export interface DemoSeedSummary {
  agentsCreated: string[];
  agentsActivated: string[];
  docsIngested: string[];
  docsSkipped: boolean;
  configSet: string[];
  switchesSet: string[];
}

/**
 * Run all three seed phases against the already-bootstrapped env. App modules
 * are imported dynamically here, AFTER bootstrapDemoEnv() has populated
 * process.env, because the repos capture their table name at module load.
 */
export async function runDemoSeed(log: (s: string) => void): Promise<DemoSeedSummary> {
  const { getAgent } = await import('../../src/lib/state/agents-repo.js');
  const { createAgentFull, activateAgent } = await import('../../src/lib/agents/agent-manager.js');
  const { getTemplate } = await import('../../src/lib/agents/templates.js');
  const { setConfig } = await import('../../src/lib/state/runtime-config-repo.js');
  const { setKillSwitch } = await import('../../src/lib/state/kill-switches-repo.js');

  const summary: DemoSeedSummary = {
    agentsCreated: [],
    agentsActivated: [],
    docsIngested: [],
    docsSkipped: false,
    configSet: [],
    switchesSet: [],
  };

  // Phase 1: fleet.
  log(bold('Phase 1: fleet'));
  for (const id of SEED_AGENT_IDS) {
    const template = getTemplate(id);
    if (!template) {
      // Defensive: the seed ids and the gallery template ids are the same set.
      log(fail(`no template "${id}" - skipping (gallery and demo fleet drifted apart)`));
      continue;
    }
    const existing = await getAgent(id);
    if (!existing) {
      await createAgentFull({
        id,
        name: template.displayName,
        description: template.description,
        template: id,
        knowledgeScope: template.suggestedKnowledgeScope ?? 'default',
        createdBy: 'demo-seed',
      });
      summary.agentsCreated.push(id);
      log(ok(`created ${id} (${template.displayName})`));
    } else {
      log(dim(`exists  ${id} (left as-is)`));
    }
    await activateAgent(id);
    summary.agentsActivated.push(id);
  }

  // Phase 2: knowledge.
  log(bold('Phase 2: knowledge'));
  if (!process.env.VECTORS_BUCKET) {
    summary.docsSkipped = true;
    log(fail('VECTORS_BUCKET unset - skipping knowledge ingest (fleet + lockdown still applied)'));
  } else {
    const { ingestDocument } = await import('../../src/lib/vectors/ingest.js');
    for (const doc of DEMO_DOCS) {
      const res = await ingestDocument({
        scope: doc.scope,
        docId: doc.docId,
        docTitle: doc.docTitle,
        source: `demo-seed:${doc.docId}`,
        content: doc.content,
        format: 'markdown',
        tags: doc.tags,
      });
      summary.docsIngested.push(doc.docId);
      const note = res.failed > 0 ? ` (${res.failed} chunks failed, re-run later)` : '';
      log(ok(`ingested ${doc.docId} -> ${doc.scope} (${res.chunks} chunks)${note}`));
    }
  }

  // Phase 3: lockdown.
  log(bold('Phase 3: lockdown'));
  for (const c of LOCKDOWN.config) {
    await setConfig(c.category, c.key, c.value, { updatedBy: 'demo-seed' });
    summary.configSet.push(`${c.category}/${c.key}=${c.value}`);
    log(ok(`config  ${c.category}/${c.key} = ${c.value}`));
  }
  for (const name of LOCKDOWN.block) {
    await setKillSwitch(name, true, 'demo lockdown', 'demo-seed');
    summary.switchesSet.push(`${name}=blocked`);
    log(ok(`switch  ${name} = blocked`));
  }
  for (const name of LOCKDOWN.ensureOn) {
    await setKillSwitch(name, true, 'demo lockdown', 'demo-seed');
    summary.switchesSet.push(`${name}=on`);
    log(ok(`switch  ${name} = on`));
  }
  for (const name of LOCKDOWN.ensureOff) {
    await setKillSwitch(name, false, 'demo lockdown', 'demo-seed');
    summary.switchesSet.push(`${name}=off`);
    log(ok(`switch  ${name} = off`));
  }

  return summary;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const lines: string[] = [];
  const log = (s: string) => {
    if (json) lines.push(s);
    else console.log(s);
  };

  try {
    const { region, envFlag } = bootstrapDemoEnv(argv);
    if (!json) console.log(bold(`Seeding demo instance (${envFlag}, ${region})`));
    const summary = await runDemoSeed(log);
    if (json) {
      console.log(JSON.stringify({ ok: true, ...summary }));
    } else {
      console.log(
        bold(
          `done: ${summary.agentsActivated.length} agents active, ` +
            `${summary.docsIngested.length} docs, ${summary.switchesSet.length} switches`,
        ),
      );
    }
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (json) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(fail(msg));
    process.exit(1);
  }
}

// Only run when invoked directly, so reset.ts can import runDemoSeed without
// triggering a second CLI run.
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
