export interface ShadowUser {
  netzerUserId: string;
  slot: string;
  paperclipUserId: string;
  decisionClasses: string[];
  status: 'active' | 'retired';
  assignedAt: number;
  retiredAt?: number;
}

export interface ShadowRows {
  getByNetzerUser(netzerUserId: string): Promise<ShadowUser | undefined>;
  getByPaperclipUser(paperclipUserId: string): Promise<ShadowUser | undefined>;
}
