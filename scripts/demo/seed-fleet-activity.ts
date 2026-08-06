/**
 * `AWS_REGION=us-east-1 tsx scripts/demo/seed-fleet-activity.ts [--clean]`
 *
 * Seed a believable three-agent fleet (main / ops / research) that has been
 * doing realistic work and handing tasks back and forth, so the dashboard
 * Overview shows a live team and the scripted Demo Walkthrough can open by
 * catching the owner up on "what your agents have been up to."
 *
 * Writes ONLY additive demo data via the repo's own functions (correct shapes):
 *   - 3 active agents (claudeclaw-agents)
 *   - 6 recent sessions with realistic transcripts (claudeclaw-sessions)
 *   - inter-agent delegations main<->research, main<->ops (claudeclaw-inter-agent-tasks)
 *   - usage rows so each agent shows recent messages + a little spend (claudeclaw-token-usage)
 *
 * This is NOT the full demo seed: it sets NO kill switches and NO cost cap, so
 * it is safe to run against the live single-user prod. `--clean` removes the
 * agents, their sessions, and their inter-agent tasks (usage rows expire on TTL).
 *
 * Idempotent: sessions and inter-agent tasks are cleared before reseeding;
 * agents are upserted. Re-running adds a few more usage rows (harmless, TTL'd).
 */

process.env.AWS_REGION ??= 'us-east-1';

import { createAgent, getAgent, updateAgent, deleteAgent } from '../../src/lib/state/agents-repo.js';
import { appendTurns, deleteSession } from '../../src/lib/state/sessions-repo.js';
import {
  sendInterAgent,
  markStatus,
  listInbox,
  deleteInterAgentTask,
} from '../../src/lib/state/inter-agent-tasks-repo.js';
import { recordUsage } from '../../src/lib/usage/token-tracker.js';
import type { AgentMetadata } from '../../src/lib/agents/types.js';

// Bedrock cross-region inference-profile id — NO foundation-model `-v1:0`
// suffix (that variant doesn't exist and Bedrock rejects it with "The provided
// model identifier is invalid"). Matches the canonical default in
// src/lib/agents/agent-manager.ts. A prior `-v1:0` value here got seeded onto
// the live main/ops/research rows and broke every Slack/Telegram turn.
const MODEL = 'us.anthropic.claude-sonnet-4-6';
const NOW = Math.floor(Date.now() / 1000);
const H = 3600;

const AGENTS: Array<Pick<AgentMetadata, 'agentId' | 'displayName' | 'description'>> = [
  {
    agentId: 'main',
    displayName: 'Main',
    description: 'Your primary assistant. Coordinates the team, drafts your comms, and keeps you briefed.',
  },
  {
    agentId: 'ops',
    displayName: 'Ops',
    description: 'Runs deployments, watches cost and infrastructure, and handles scheduling.',
  },
  {
    agentId: 'research',
    displayName: 'Research',
    description: 'Gathers market intel, competitor analysis, and the data behind decisions.',
  },
];

// chatId -> conversation. Each is a short, realistic transcript. ts are spread
// across today so transcripts read naturally; appendTurns stamps updatedAt=now
// so they all show as recent on the Overview "recent sessions" card.
const SESSIONS: Array<{ agentId: string; chatId: string; surface: 'dashboard' | 'telegram' | 'slack' | 'system'; turns: Array<{ role: 'user' | 'assistant'; text: string; agoH: number }> }> = [
  {
    agentId: 'main',
    chatId: 'daily-sync',
    surface: 'dashboard',
    turns: [
      { role: 'user', text: 'Catch me up on what the team handled today.', agoH: 2 },
      { role: 'assistant', text: 'Research finished the competitor pricing pull, Ops staged the v1.2 rollout, and I drafted the customer update. Want details on any of them?', agoH: 2 },
    ],
  },
  {
    agentId: 'main',
    chatId: 'customer-update',
    surface: 'dashboard',
    turns: [
      { role: 'user', text: 'Draft the customer update for the v1.2 release.', agoH: 5 },
      { role: 'assistant', text: 'Drafted. It leads with the reliability improvements, one line on the new pricing, and a clear upgrade call to action. Ready for your review.', agoH: 5 },
    ],
  },
  {
    agentId: 'research',
    chatId: 'competitor-pricing',
    surface: 'dashboard',
    turns: [
      { role: 'user', text: 'Compare our pricing against the top three competitors.', agoH: 6 },
      { role: 'assistant', text: 'We are about fifteen percent under on the entry tier and on par at pro. Two of them just added annual discounts. Full breakdown is saved to the shared doc.', agoH: 6 },
    ],
  },
  {
    agentId: 'research',
    chatId: 'market-scan',
    surface: 'telegram',
    turns: [
      { role: 'user', text: 'Anything new in the market this week?', agoH: 3 },
      { role: 'assistant', text: 'One competitor launched a free tier this morning. I can put together a quick teardown if that is useful.', agoH: 3 },
    ],
  },
  {
    agentId: 'ops',
    chatId: 'v12-rollout',
    surface: 'dashboard',
    turns: [
      { role: 'user', text: 'Stage the v1.2 release with a canary and a rollback step.', agoH: 7 },
      { role: 'assistant', text: 'Ready. Ten percent canary, watch the error rate for twenty minutes, then go full. Rollback is the previous task definition, one command away.', agoH: 7 },
    ],
  },
  {
    agentId: 'ops',
    chatId: 'cost-watch',
    surface: 'system',
    turns: [
      { role: 'user', text: 'How did spend look yesterday?', agoH: 9 },
      { role: 'assistant', text: 'About nine dollars, well under the daily cap. The NAT gateway is the main driver, the model calls are minor.', agoH: 9 },
    ],
  },
];

// The literal agent-to-agent back and forth, main orchestrating the two specialists.
const TASKS: Array<{ fromAgent: string; toAgent: string; fromChat: string; messageText: string; intent: 'fyi' | 'request'; status?: 'completed' }> = [
  { fromAgent: 'main', toAgent: 'research', fromChat: 'daily-sync', intent: 'request', messageText: 'Pull this week’s competitor pricing and positioning for our top three.' },
  { fromAgent: 'research', toAgent: 'main', fromChat: 'competitor-pricing', intent: 'request', status: 'completed', messageText: 'Competitor pricing is in: we are fifteen percent under on entry, on par at pro. Two added annual discounts.' },
  { fromAgent: 'main', toAgent: 'ops', fromChat: 'daily-sync', intent: 'request', messageText: 'Stage the v1.2 rollout with a canary and a rollback step.' },
  { fromAgent: 'ops', toAgent: 'main', fromChat: 'v12-rollout', intent: 'request', status: 'completed', messageText: 'Rollout plan ready: ten percent canary, twenty minute watch, then full. Rollback is the previous task definition.' },
  { fromAgent: 'research', toAgent: 'main', fromChat: 'market-scan', intent: 'fyi', messageText: 'Heads up, a competitor launched a free tier this morning. Want a teardown?' },
  { fromAgent: 'ops', toAgent: 'main', fromChat: 'cost-watch', intent: 'fyi', messageText: 'Yesterday’s spend was about nine dollars, well under the cap.' },
];

async function clean(): Promise<void> {
  for (const s of SESSIONS) await deleteSession(s.agentId, s.chatId).catch(() => {});
  // Inter-agent tasks live under the recipient; clear the inbox for each agent.
  for (const a of AGENTS) {
    const inbox = await listInbox(a.agentId).catch(() => []);
    for (const t of inbox) await deleteInterAgentTask(t).catch(() => {});
  }
}

async function seed(): Promise<void> {
  // 1) Agents (upsert + active).
  for (const a of AGENTS) {
    const existing = await getAgent(a.agentId);
    if (existing) {
      await updateAgent(a.agentId, { displayName: a.displayName, description: a.description, status: 'active', model: MODEL });
    } else {
      const meta: AgentMetadata = {
        agentId: a.agentId,
        displayName: a.displayName,
        description: a.description,
        model: MODEL,
        status: 'active',
        knowledgeScope: 'default',
        createdAt: new Date(Date.now() - 30 * 24 * H * 1000).toISOString(),
        updatedAt: new Date().toISOString(),
        createdBy: 'fleet-activity-seed',
      };
      await createAgent(meta);
    }
    console.log(`  agent ${a.agentId} ready`);
  }

  // 2) Sessions (fresh: clear then append so re-runs do not duplicate turns).
  for (const s of SESSIONS) {
    await deleteSession(s.agentId, s.chatId).catch(() => {});
    const turns = s.turns.map((t) => ({ role: t.role, text: t.text, ts: NOW - t.agoH * H }));
    await appendTurns(s.agentId, s.chatId, turns, undefined, { surface: s.surface });
    console.log(`  session ${s.agentId}/${s.chatId} (${turns.length} turns)`);
  }

  // 3) Inter-agent back and forth.
  for (const t of TASKS) {
    const task = await sendInterAgent({
      fromAgent: t.fromAgent,
      toAgent: t.toAgent,
      fromChat: t.fromChat,
      messageText: t.messageText,
      intent: t.intent,
    });
    if (t.status) await markStatus(task, t.status);
    console.log(`  task ${t.fromAgent} -> ${t.toAgent} (${t.intent}${t.status ? ', ' + t.status : ''})`);
  }

  // 4) Usage rows so each agent shows recent messages + a little spend (health).
  for (const a of AGENTS) {
    const rows = 8 + Math.floor((a.agentId.length % 4)); // 8-11 per agent, deterministic
    for (let i = 0; i < rows; i++) {
      await recordUsage({
        agentId: a.agentId,
        chatId: 'seed',
        surface: 'dashboard',
        modelId: MODEL,
        inputTokens: 1200 + i * 40,
        outputTokens: 300 + i * 20,
        costUsd: 0.018,
        latencyMs: 1400 + (i % 5) * 120,
      });
    }
    console.log(`  usage ${a.agentId} (${rows} rows)`);
  }
}

async function main(): Promise<void> {
  const doClean = process.argv.includes('--clean');
  if (doClean) {
    console.log('Cleaning seeded fleet activity...');
    await clean();
    for (const a of AGENTS) await deleteAgent(a.agentId).catch(() => {});
    console.log('Done. (usage rows expire on TTL)');
    return;
  }
  console.log('Seeding fleet activity (main / ops / research)...');
  await seed();
  console.log('Done. Overview should now show 3 active agents with recent activity.');
}

main().catch((e) => {
  console.error('seed-fleet-activity failed:', e);
  process.exit(1);
});
