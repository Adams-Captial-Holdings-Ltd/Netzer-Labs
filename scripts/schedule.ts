/**
 * Schedule CLI — manage scheduled tasks from the terminal.
 *
 * Usage:
 *   tsx scripts/schedule.ts list [--agent=<id>]
 *   tsx scripts/schedule.ts show <taskId>
 *   tsx scripts/schedule.ts create --agent=<id> --cron="0 9 * * *" --prompt="..."
 *   tsx scripts/schedule.ts delete <taskId>
 *   tsx scripts/schedule.ts pause <taskId>
 *   tsx scripts/schedule.ts resume <taskId>
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

async function listSchedules(flags: Record<string, string>): Promise<void> {
  const agentFilter = flags.agent ? `?agent=${encodeURIComponent(flags.agent)}` : '';
  const data = await apiGet<{ tasks: Array<{ id: string; cron: string; status: string; agentId: string; prompt: string; nextRun?: string }> }>(
    `/api/schedules${agentFilter}`,
  );
  section('Scheduled Tasks');
  if (!data.tasks?.length) {
    console.log(dim('  No scheduled tasks found.'));
    return;
  }
  for (const t of data.tasks) {
    const statusColor = t.status === 'active' ? green : t.status === 'paused' ? yellow : red;
    console.log(`  ${bold(t.id)}  ${t.cron}  ${statusColor(t.status)}  ${dim(t.agentId)}  ${dim(t.prompt.slice(0, 60))}`);
    if (t.nextRun) console.log(`    ${dim('next: ' + t.nextRun)}`);
  }
}

async function showSchedule(taskId: string): Promise<void> {
  const data = await apiGet<{ task: Record<string, unknown> }>(`/api/schedules/${encodeURIComponent(taskId)}`);
  section(`Schedule: ${taskId}`);
  console.log(JSON.stringify(data.task, null, 2));
}

async function createSchedule(flags: Record<string, string>): Promise<void> {
  if (!flags.agent || !flags.cron || !flags.prompt) {
    console.error(red('Required: --agent=<id> --cron="..." --prompt="..."'));
    process.exit(1);
  }
  const result = await apiPost<{ taskId: string }>('/api/schedules', {
    agentId: flags.agent,
    cron: flags.cron,
    prompt: flags.prompt,
  });
  console.log(green(`Schedule created: ${result.taskId}`));
}

async function deleteSchedule(taskId: string): Promise<void> {
  await apiPost(`/api/schedules/${encodeURIComponent(taskId)}/delete`);
  console.log(green(`Schedule ${taskId} deleted.`));
}

async function toggleSchedule(taskId: string, action: 'pause' | 'resume'): Promise<void> {
  await apiPost(`/api/schedules/${encodeURIComponent(taskId)}/${action}`);
  console.log(green(`Schedule ${taskId} ${action}d.`));
}

async function run(): Promise<void> {
  const flags = parseFlags(rest);
  switch (command) {
    case 'list':
      await listSchedules(flags);
      break;
    case 'show':
      if (!flags._positional) { console.error(red('Usage: schedule.ts show <taskId>')); process.exit(1); }
      await showSchedule(flags._positional);
      break;
    case 'create':
      await createSchedule(flags);
      break;
    case 'delete':
      if (!flags._positional) { console.error(red('Usage: schedule.ts delete <taskId>')); process.exit(1); }
      await deleteSchedule(flags._positional);
      break;
    case 'pause':
    case 'resume':
      if (!flags._positional) { console.error(red(`Usage: schedule.ts ${command} <taskId>`)); process.exit(1); }
      await toggleSchedule(flags._positional, command);
      break;
    default:
      console.log(bold('Schedule CLI'));
      console.log('  list [--agent=<id>]');
      console.log('  show <taskId>');
      console.log('  create --agent=<id> --cron="..." --prompt="..."');
      console.log('  delete <taskId>');
      console.log('  pause <taskId>');
      console.log('  resume <taskId>');
      break;
  }
}

run().catch((err) => {
  console.error(red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
