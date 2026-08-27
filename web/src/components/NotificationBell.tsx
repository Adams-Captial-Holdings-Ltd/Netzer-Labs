import { useState, useEffect, useCallback } from 'preact/hooks';
import { api } from '../lib/api';

interface Notification {
  id: string;
  type: 'kill_switch' | 'cost_warning' | 'health_change' | 'auth_anomaly';
  title: string;
  detail: string;
  ts: string;
}

// Left accent stripe + icon tint per notification type. Unknown types fall back
// to a neutral accent so a new backend type still renders cleanly.
const TYPE_ACCENT: Record<Notification['type'], string> = {
  kill_switch: 'border-l-2 border-l-danger',
  cost_warning: 'border-l-2 border-l-warning',
  auth_anomaly: 'border-l-2 border-l-danger',
  health_change: 'border-l-2 border-l-warning',
};

export function NotificationBell() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(sessionStorage.getItem('cce_ack_notifs') ?? '[]'));
    } catch { return new Set(); }
  });

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ notifications: Notification[] }>('/notifications');
      setNotifications(res.notifications ?? []);
    } catch { /* endpoint may not exist yet */ }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  const unread = notifications.filter((n) => !acknowledged.has(n.id));

  const ack = (id: string) => {
    const next = new Set(acknowledged);
    next.add(id);
    setAcknowledged(next);
    sessionStorage.setItem('cce_ack_notifs', JSON.stringify([...next]));
  };

  const ackAll = () => {
    const next = new Set([...acknowledged, ...notifications.map((n) => n.id)]);
    setAcknowledged(next);
    sessionStorage.setItem('cce_ack_notifs', JSON.stringify([...next]));
  };

  return (
    <div class="relative">
      <button
        onClick={() => setOpen(!open)}
        class="p-1.5 rounded-md hover:bg-bg-elevated text-secondary transition-colors relative"
        aria-label="Notifications"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread.length > 0 && (
          <span class="absolute -top-0.5 -right-0.5 w-4 h-4 bg-danger text-white text-[10px] font-bold rounded-full flex items-center justify-center">
            {unread.length > 9 ? '9+' : unread.length}
          </span>
        )}
      </button>
      {/* `max-w-[calc(100vw-1rem)]`: this bell also renders inside the
          260px-wide mobile nav drawer now (Sidebar.tsx's account row, on the
          routes where the house header stands down below `lg`), and a fixed
          320px panel anchored to its right edge hung 60px off the left of the
          viewport with the first characters of every notification outside the
          screen. Widths only ever shrink here — at every viewport that could
          already show 320px, nothing changes. */}
      {open && (
        <div class="absolute right-0 top-10 w-80 max-w-[calc(100vw-1rem)] bg-surface border border-border rounded-lg shadow-lg z-50 max-h-96 overflow-y-auto">
          <div class="p-3 border-b border-border flex items-center justify-between">
            <span class="text-sm font-medium text-primary">Notifications</span>
            {unread.length > 0 && (
              <button onClick={ackAll} class="text-xs text-accent hover:underline">
                Mark all read
              </button>
            )}
          </div>
          {notifications.length === 0 ? (
            <div class="p-4 text-sm text-muted text-center">No notifications</div>
          ) : (
            notifications.map((n) => (
              <div
                key={n.id}
                class={`p-3 border-b border-border last:border-b-0 ${TYPE_ACCENT[n.type] ?? 'border-l-2 border-l-accent'} ${acknowledged.has(n.id) ? 'opacity-50' : ''}`}
              >
                <div class="flex items-start justify-between gap-2">
                  <div>
                    <div class="text-sm font-medium text-primary">{n.title}</div>
                    <div class="text-xs text-muted mt-0.5">{n.detail}</div>
                    <div class="text-[10px] text-muted mt-1">{new Date(n.ts).toLocaleString()}</div>
                  </div>
                  {!acknowledged.has(n.id) && (
                    <button onClick={() => ack(n.id)} class="text-[10px] text-accent hover:underline whitespace-nowrap mt-0.5">
                      Dismiss
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
