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
import { pathToFileURL } from 'node:url';

interface MissionRow {
  id: string;
  ownerAgent: string;
  title: string;
  status: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
}

interface AgentSummary {
  id: string;
}

export function parseFlags(args: string[]): Record<string, string> {
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

export async function listMissions(flags: Record<string, string>): Promise<void> {
  const ownerFilter = flags.agent ? `?owner=${encodeURIComponent(flags.agent)}` : '';
  const missions = await apiGet<{ missions: MissionRow[] }>(
    `/api/missions${ownerFilter}`,
  );
  section('Missions');
  if (!missions.missions?.length) {
    console.log(dim('  No missions found.'));
    return;
  }
  for (const m of missions.missions) {
    const statusColor = m.status === 'done' ? green : ['blocked', 'cancelled'].includes(m.status) ? red : yellow;
    console.log(`  ${bold(m.id)}  ${m.title}  ${statusColor(m.status)}  ${dim(m.ownerAgent)}  ${dim(m.priority)}`);
  }
}

export async function showMission(missionId: string): Promise<void> {
  // There is no mission-detail route. Resolve the id through the real bounded
  // owner-scoped board routes, using the real agent inventory for those owners.
  const { agents } = await apiGet<{ agents: AgentSummary[] }>('/api/agents');
  const rows: MissionRow[] = [];
  // The Paperclip client enforces an eight-request actor ceiling. Scan owners
  // serially so a fleet with more than eight agents cannot self-throttle this
  // CLI command before it has resolved the requested id.
  for (const agent of agents) {
    const board = await apiGet<{ missions: MissionRow[] }>(
      `/api/missions?owner=${encodeURIComponent(agent.id)}`,
    );
    rows.push(...(board.missions ?? []));
  }
  const exact = rows.find((mission) => mission.id === missionId);
  const prefixMatches = exact ? [] : rows.filter((mission) => mission.id.startsWith(missionId));
  if (!exact && prefixMatches.length > 1) {
    throw new Error(`Mission id '${missionId}' is ambiguous; pass a full mission id.`);
  }
  const mission = exact ?? prefixMatches[0];
  if (!mission) throw new Error(`Mission '${missionId}' was not found.`);

  section(`Mission: ${mission.id}`);
  console.log(JSON.stringify(mission, null, 2));
}

export async function createMission(flags: Record<string, string>): Promise<void> {
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
    };
  }>('/api/missions', body);
  console.log(green(`Mission created: ${mission.id}`));
  if (mission.title) console.log(`  ${dim('title')}   ${mission.title}`);
  if (mission.ownerAgent) console.log(`  ${dim('owner')}   ${mission.ownerAgent}`);
  if (mission.assignmentReason) console.log(`  ${dim('reason')}  ${mission.assignmentReason}`);
}

export async function run(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
}
