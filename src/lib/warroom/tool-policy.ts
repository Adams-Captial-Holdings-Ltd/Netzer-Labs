/**
 * Per-meeting tool policy. Controls which tools agents can invoke
 * during a war room session.
 */

const DEFAULT_BLOCKED: readonly string[] = [
  'send_dm',
  'create_mission',
  'forget_memory',
] as const;

export function isToolAllowed(
  toolName: string,
  overrides?: Record<string, boolean>,
): boolean {
  if (overrides && toolName in overrides) return overrides[toolName];
  return !DEFAULT_BLOCKED.includes(toolName);
}

export function getBlockedTools(overrides?: Record<string, boolean>): string[] {
  const blocked = new Set<string>(DEFAULT_BLOCKED);
  if (overrides) {
    for (const [tool, allowed] of Object.entries(overrides)) {
      if (allowed) blocked.delete(tool);
      else blocked.add(tool);
    }
  }
  return [...blocked];
}
