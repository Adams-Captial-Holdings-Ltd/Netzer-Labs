import { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';

/** A single labeled field to render from the data object. */
export interface RawJsonField {
  /** Key to read from the data object. Dotted paths (`a.b`) are supported. */
  key: string;
  /** Human-friendly label. Defaults to a prettified version of `key`. */
  label?: string;
  /** Optional custom renderer for the value. Receives the raw value. */
  render?: (value: unknown) => ComponentChildren;
}

interface RawJsonBlockProps {
  /** The object to display. */
  data: Record<string, unknown> | null | undefined;
  /**
   * Which fields to surface in the labeled view, in order. If omitted, every
   * top-level key of `data` is shown.
   */
  fields?: RawJsonField[];
  /** Optional title rendered above the fields. */
  title?: string;
}

/** ISO-8601 timestamp detector (e.g. 2026-06-02T14:33:00Z / with offset / ms). */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

function prettifyKey(key: string): string {
  const last = key.split('.').pop() ?? key;
  return last
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

/** Read a possibly-dotted path out of an object. */
function readPath(obj: Record<string, unknown>, path: string): unknown {
  if (path in obj) return obj[path];
  return path.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object' && part in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, obj);
}

/** Render a primitive value, formatting ISO timestamps to local time. */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '--';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (ISO_RE.test(value)) {
      const d = new Date(value);
      if (!isNaN(d.getTime())) {
        return d.toLocaleString(undefined, {
          year: 'numeric', month: 'short', day: 'numeric',
          hour: '2-digit', minute: '2-digit',
        });
      }
    }
    return value;
  }
  // Objects / arrays in the labeled view: compact JSON so the row stays scannable.
  try { return JSON.stringify(value); } catch { return String(value); }
}

/**
 * Renders an object as labeled key/value fields by default, with a
 * "Show raw JSON" toggle that reveals the pretty-printed JSON.
 *
 * ISO timestamp strings are formatted to a readable local string in the
 * labeled view; the raw JSON view shows the data verbatim.
 */
export function RawJsonBlock({ data, fields, title }: RawJsonBlockProps) {
  const [showRaw, setShowRaw] = useState(false);

  const hasData = data != null && typeof data === 'object';
  const effectiveFields: RawJsonField[] = hasData
    ? (fields ?? Object.keys(data as Record<string, unknown>).map((key) => ({ key })))
    : [];

  return (
    <div class="bg-surface border border-border rounded-xl overflow-hidden">
      <div class="flex items-center justify-between px-4 py-2.5 border-b border-border bg-surface-elevated">
        <span class="text-overline text-muted uppercase tracking-wider font-semibold">
          {title ?? 'Details'}
        </span>
        <button
          type="button"
          onClick={() => setShowRaw((v) => !v)}
          aria-pressed={showRaw}
          class="text-caption font-medium text-secondary hover:text-primary transition-colors
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-md px-1"
        >
          {showRaw ? 'Show fields' : 'Show raw JSON'}
        </button>
      </div>

      {!hasData ? (
        <div class="px-4 py-4 text-body-sm text-muted">No data.</div>
      ) : showRaw ? (
        <pre class="px-4 py-3 text-caption text-secondary font-mono whitespace-pre-wrap break-words max-h-80 overflow-y-auto">
          {JSON.stringify(data, null, 2)}
        </pre>
      ) : (
        <dl class="divide-y divide-border">
          {effectiveFields.map((f) => {
            const raw = readPath(data as Record<string, unknown>, f.key);
            return (
              <div key={f.key} class="flex gap-4 px-4 py-2.5">
                <dt class="w-40 shrink-0 text-body-sm text-muted">{f.label ?? prettifyKey(f.key)}</dt>
                <dd class="flex-1 text-body-sm text-primary break-words min-w-0">
                  {f.render ? f.render(raw) : formatValue(raw)}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </div>
  );
}
