/**
 * Server-rendered HTML for the status page (D5).
 *
 * Deliberately minimal: zero JS, inline CSS, single string. Renders
 * the assembled StatusData into a public, no-auth page that loads
 * fast even when the API behind it is unhappy. The page exists to
 * answer one question — "is the system up right now" — and nothing
 * more.
 */

import type { StatusData } from './data.js';

const STATUS_COLORS = {
  ok: '#16a34a',
  degraded: '#d97706',
  down: '#dc2626',
} as const;

const STATUS_LABELS = {
  ok: 'All systems operational',
  degraded: 'Degraded performance',
  down: 'Active incident',
} as const;

function esc(input: unknown): string {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtRelative(iso: string | undefined): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function renderStatusPage(data: StatusData): string {
  const color = STATUS_COLORS[data.overall];
  const label = STATUS_LABELS[data.overall];
  const alarmsActive = data.alarms.filter((a) => a.state === 'ALARM');
  const alarmsOther = data.alarms.filter((a) => a.state !== 'ALARM');

  const alarmRows = alarmsActive
    .concat(alarmsOther)
    .map((a) => {
      const stateColor =
        a.state === 'ALARM'
          ? '#dc2626'
          : a.state === 'OK'
            ? '#16a34a'
            : '#737373';
      return `<tr>
  <td><code>${esc(a.name)}</code></td>
  <td><span style="color:${stateColor};font-weight:600">${esc(a.state)}</span></td>
  <td style="color:#6b7280">${esc(fmtRelative(a.updatedAt))}</td>
</tr>`;
    })
    .join('\n');

  const deployRows = data.deploys
    .map(
      (d) =>
        `<tr>
  <td><code>${esc(d.stack)}</code></td>
  <td>${esc(d.status)}</td>
  <td style="color:#6b7280">${esc(fmtRelative(d.timestamp))}</td>
</tr>`,
    )
    .join('\n');

  const uptimeText =
    data.canary.uptimePct === null
      ? 'no canary data'
      : `${data.canary.uptimePct.toFixed(1)}% over last ${data.canary.windowHours}h (${data.canary.ok}/${data.canary.total})`;

  const sourceErrorsBlock =
    data.sourceErrors.length === 0
      ? ''
      : `<div style="margin-top:24px;padding:12px;border:1px solid #fde68a;background:#fffbeb;color:#92400e;border-radius:6px;font-size:13px">
  <strong>Page partial:</strong> some data sources failed to load. The signals shown above are still current; the missing sections will populate on the next refresh.
  <ul style="margin:6px 0 0 18px;padding:0">
    ${data.sourceErrors.map((e) => `<li><code>${esc(e)}</code></li>`).join('')}
  </ul>
</div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>ClaudeClaw status</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="60">
  <style>
    :root { color-scheme: light dark; }
    body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 24px; background: #f9fafb; color: #111827; max-width: 880px; margin: 0 auto; }
    h1 { font-size: 18px; margin: 0 0 4px; color: #6b7280; font-weight: 500; }
    .banner { padding: 24px; border-radius: 10px; color: #fff; margin: 12px 0 28px; }
    .banner .state { font-size: 28px; font-weight: 600; }
    .banner .sub { font-size: 14px; opacity: 0.92; margin-top: 4px; }
    h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.04em; color: #6b7280; margin: 28px 0 10px; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
    th, td { padding: 10px 14px; text-align: left; font-size: 13px; border-bottom: 1px solid #f3f4f6; }
    th { background: #f9fafb; color: #6b7280; text-transform: uppercase; font-size: 11px; letter-spacing: 0.04em; font-weight: 600; }
    tr:last-child td { border-bottom: 0; }
    code { font: 12px/1.4 ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; color: #1f2937; }
    .empty { padding: 14px; color: #9ca3af; background: #fff; border-radius: 8px; font-size: 13px; }
    footer { margin-top: 36px; color: #9ca3af; font-size: 12px; }
    footer a { color: #6b7280; }
  </style>
</head>
<body>
  <h1>Netzar OS Enterprise</h1>
  <div class="banner" style="background:${color}">
    <div class="state">${esc(label)}</div>
    <div class="sub">Generated ${esc(data.generatedAt)} (auto-refreshes every 60s)</div>
  </div>

  <h2>Canary (synthetic uptime)</h2>
  <table><tbody>
    <tr><td>Uptime</td><td colspan="2">${esc(uptimeText)}</td></tr>
    <tr><td>Last canary</td><td>${esc(data.canary.lastResult ?? '—')}</td><td style="color:#6b7280">${esc(fmtRelative(data.canary.lastFiredAt))}</td></tr>
  </tbody></table>

  <h2>Alarms (${data.alarms.length} tracked, ${alarmsActive.length} active)</h2>
  ${data.alarms.length === 0
    ? '<div class="empty">No alarms reported by CloudWatch under this prefix.</div>'
    : `<table>
        <thead><tr><th>Name</th><th>State</th><th>Updated</th></tr></thead>
        <tbody>${alarmRows}</tbody>
      </table>`}

  <h2>Recent deploys (${data.deploys.length})</h2>
  ${data.deploys.length === 0
    ? '<div class="empty">No recent stack updates visible.</div>'
    : `<table>
        <thead><tr><th>Stack</th><th>Status</th><th>When</th></tr></thead>
        <tbody>${deployRows}</tbody>
      </table>`}

  ${sourceErrorsBlock}

  <footer>
    Public status page. Machine-readable shape at <a href="/status/data.json">/status/data.json</a>.
  </footer>
</body>
</html>`;
}
