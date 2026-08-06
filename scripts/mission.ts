/**
 * Mission CLI — manage missions and tasks from the terminal.
 *
 * Usage:
 *   tsx scripts/mission.ts list [--agent=<id>]
 *   tsx scripts/mission.ts show <missionId>
 *   tsx scripts/mission.ts create --prompt="..." [--agent=<id>] [--title="..."]
 */

import { apiGet, apiPost } from './lib/api-client.js';
import { bold, dim, green, red, yellow, section } from './lib/ansi.js';

const [, , command, ...rest] = process.argv;

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        flags[arg.slice(2)] = 'true';
      }
    } else {
      flags._positional = arg;
    }
  }
  return flags;
}

async function listMissions(flags: Record<string, string>): Promise<void> {
  const agentFilter = flags.agent ? `?agent=${encodeURIComponent(flags.agent)}` : '';
  const missions = await apiGet<{ missions: Array<{ id: string; title: string; status: string; agentId: string; priority: string }> }>(
    `/api/missions${agentFilter}`,
  );
  section('Missions');
  if (!missions.missions?.length) {
    console.log(dim('  No missions found.'));
    return;
  }
  for (const m of missions.missions) {
    const statusColor = m.status === 'active' ? green : m.status === 'blocked' ? red : yellow;
    console.log(`  ${bold(m.id)}  ${m.title}  ${statusColor(m.status)}  ${dim(m.agentId)}  ${dim(m.priority)}`);
  }
}

async function showMission(missionId: string): Promise<void> {
  const mission = await apiGet<{ mission: Record<string, unknown>; tasks: Array<Record<string, unknown>> }>(
    `/api/missions/${encodeURIComponent(missionId)}`,
  );
  section(`Mission: ${missionId}`);
  console.log(JSON.stringify(mission.mission, null, 2));
  if (mission.tasks?.length) {
    section('Tasks');
    for (const t of mission.tasks) {
      console.log(`  ${dim(String(t.id))}  ${t.title}  ${dim(String(t.status))}`);
    }
  }
}

async function createMission(flags: Record<string, string>): Promise<void> {
  // The contract route is POST /api/missions with body
  // { prompt, agentId?, title? }. `prompt` is the only required field; omit
  // agentId entirely to let the backend Haiku auto-assign. The old CLI POSTed
  // { agentId, title, priority } which 404'd against the real route.
  const prompt = flags.prompt ?? flags.title;
  if (!prompt) {
    console.error(red('Required: --prompt="..." (optional: --agent=<id> --title="...")'));
    process.exit(1);
  }
  const body: { prompt: string; agentId?: string; title?: string } = { prompt };
  if (flags.agent) body.agentId = flags.agent;
  if (flags.title) body.title = flags.title;
  // The route wraps the created row as { mission } and returns 201.
  const { mission } = await apiPost<{
    mission: {
      id: string;
      ownerAgent?: string;
      title?: string;
      assignmentReason?: string;
      dueAt?: string;
    };
  }>('/api/missions', body);
  console.log(green(`Mission created: ${mission.id}`));
  if (mission.title) console.log(`  ${dim('title')}   ${mission.title}`);
  if (mission.ownerAgent) console.log(`  ${dim('owner')}   ${mission.ownerAgent}`);
  if (mission.assignmentReason) console.log(`  ${dim('reason')}  ${mission.assignmentReason}`);
  if (mission.dueAt) console.log(`  ${dim('due')}     ${mission.dueAt}`);
}

async function run(): Promise<void> {
  const flags = parseFlags(rest);
  switch (command) {
    case 'list':
      await listMissions(flags);
      break;
    case 'show':
      if (!flags._positional) {
        console.error(red('Usage: mission.ts show <missionId>'));
        process.exit(1);
      }
      await showMission(flags._positional);
      break;
    case 'create':
      await createMission(flags);
      break;
    default:
      console.log(bold('Mission CLI'));
      console.log('  list [--agent=<id>]');
      console.log('  show <missionId>');
      console.log('  create --prompt="..." [--agent=<id>] [--title="..."]');
      break;
  }
}

run().catch((err) => {
  console.error(red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
