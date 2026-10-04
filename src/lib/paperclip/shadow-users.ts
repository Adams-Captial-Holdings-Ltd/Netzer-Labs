export interface ShadowUser {
  netzerUserId: string;
  slot: string;
  paperclipUserId: string;
  decisionClasses: string[];
  status: 'active' | 'retired';
  assignedAt: number;
  retiredAt?: number;
}

export function validShadowUser(value: unknown): value is ShadowUser {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (row.status === 'active' || row.status === 'retired')
    && ['netzerUserId', 'slot', 'paperclipUserId'].every((key) =>
      typeof row[key] === 'string' && (row[key] as string).trim().length > 0)
    && Array.isArray(row.decisionClasses) && row.decisionClasses.every((item: unknown) => typeof item === 'string')
    && typeof row.assignedAt === 'number' && Number.isFinite(row.assignedAt);
}

export interface ShadowSlot {
  slot: string;
  paperclipUserId: string;
  state: 'free' | 'assigned' | 'retired';
  netzerUserId?: string;
  assignedAt?: number;
  retiredAt?: number;
}

export interface ShadowRows {
  getByNetzerUser(netzerUserId: string): Promise<ShadowUser | undefined>;
  getByPaperclipUser(paperclipUserId: string): Promise<ShadowUser | undefined>;
  getSlot(slot: string): Promise<ShadowSlot | undefined>;
  listSlots(): Promise<ShadowSlot[]>;
  createSlot(input: { slot: string; paperclipUserId: string }): Promise<boolean>;
  assign(input: { slot: string; netzerUserId: string; decisionClasses: readonly string[]; now: number }): Promise<boolean>;
  retire(input: { netzerUserId: string; now: number }): Promise<boolean>;
}
