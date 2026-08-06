const cls = 'w-12 h-12 text-muted';
const props = { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', viewBox: '0 0 24 24', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } as const;

export const EmptyChat = () => <svg class={cls} {...props}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>;
export const EmptyBot = () => <svg class={cls} {...props}><path d="M12 8V4H8" /><rect x="4" y="8" width="16" height="12" rx="2" /><path d="M2 14h2" /><path d="M20 14h2" /><path d="M15 13v2" /><path d="M9 13v2" /></svg>;
export const EmptySessions = () => <svg class={cls} {...props}><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>;
export const EmptyUsage = () => <svg class={cls} {...props}><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></svg>;
export const EmptySearch = () => <svg class={cls} {...props}><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>;
export const EmptyBook = () => <svg class={cls} {...props}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg>;
export const EmptyTarget = () => <svg class={cls} {...props}><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" /></svg>;
export const EmptyBrain = () => <svg class={cls} {...props}><path d="M9.5 2A5.5 5.5 0 0 0 4 7.5c0 2.12 1.2 3.96 2.94 4.88" /><path d="M14.5 2A5.5 5.5 0 0 1 20 7.5c0 2.12-1.2 3.96-2.94 4.88" /><path d="M8.5 12.5c0 3.04 1.57 5.7 3.5 7.5 1.93-1.8 3.5-4.46 3.5-7.5" /><path d="M6.94 12.38C5.1 13.6 4 15.69 4 18a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2c0-2.31-1.1-4.4-2.94-5.62" /></svg>;
export const EmptyNetwork = () => <svg class={cls} {...props}><circle cx="12" cy="5" r="3" /><circle cx="19" cy="12" r="3" /><circle cx="5" cy="12" r="3" /><circle cx="12" cy="19" r="3" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="14.5" y1="6.5" x2="17" y2="10" /><line x1="9.5" y1="6.5" x2="7" y2="10" /></svg>;
export const EmptyCalendar = () => <svg class={cls} {...props}><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>;
export const EmptyWarRoom = () => <svg class={cls} {...props}><path d="M15 10l4.553-2.276A1 1 0 0 1 21 8.618v6.764a1 1 0 0 1-1.447.894L15 14v-4z" /><rect x="3" y="6" width="12" height="12" rx="2" /></svg>;
export const EmptyAudit = () => <svg class={cls} {...props}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>;
export const SuccessCheck = () => <svg class="w-12 h-12 text-success" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>;
