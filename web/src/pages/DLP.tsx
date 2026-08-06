import { useState, useEffect } from 'preact/hooks';
import { api } from '../lib/api';
import { Button } from '../components/Button';
import { Badge } from '../components/Badge';
import { Select } from '../components/Select';
import { Skeleton } from '../components/Skeleton';
import { toast } from '../components/Toast';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { InfoTooltip } from '../components/InfoTooltip';
import { RawJsonBlock } from '../components/RawJsonBlock';

interface ExfilPattern {
  id: string;
  name: string;
  regex: string;
  severity: 'block' | 'warn';
  enabled: boolean;
  builtin?: boolean;
}

interface ScanMatch {
  patternId: string;
  patternName: string;
  severity: 'block' | 'warn';
  snippet: string;
}

interface ScanResult {
  blocked: boolean;
  matches: ScanMatch[];
  scannedBytes: number;
  truncated: boolean;
}

// Shape of GET /kill-switches -> { switches: [{ name, active, ... }] }. The
// Overview page reads the same list. active===true means the switch is TRIPPED,
// i.e. that protection is DISABLED.
interface KillSwitch {
  name: string;
  active: boolean;
}

const SEVERITY_OPTIONS = [
  { value: 'block', label: 'Block (hard fail the response)' },
  { value: 'warn', label: 'Warn (log only)' },
];

/**
 * Compile-test a regex the same way the exfil guard does at runtime (global +
 * case-insensitive, see src/lib/safety/exfil-guard.ts). Returns null when the
 * pattern compiles, otherwise the engine's error message so the operator sees
 * exactly why it was rejected before it ever reaches the server.
 */
function validateRegex(source: string): string | null {
  if (!source.trim()) return null;
  try {
    new RegExp(source, 'gi');
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function DLP() {
  const [patterns, setPatterns] = useState<ExfilPattern[]>([]);
  const [loading, setLoading] = useState(true);

  // Kill-switch state. exfil_guard_disabled tripped => outbound scanning is OFF
  // and a "Clean" verdict would be a lie. exfil_custom_patterns_disabled tripped
  // => the built-in set still runs but custom patterns are not enforced.
  const [guardOff, setGuardOff] = useState(false);
  const [customPatternsOff, setCustomPatternsOff] = useState(false);
  // True when the kill-switch read itself failed (403/5xx). A security indicator
  // must fail CLOSED: we then show "guard state unknown" and suppress the green
  // "Clean" verdict instead of implying protection we could not verify.
  const [guardUnknown, setGuardUnknown] = useState(false);

  const [sample, setSample] = useState('');
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);

  // New custom pattern form.
  const [nid, setNid] = useState('');
  const [nname, setNname] = useState('');
  const [nregex, setNregex] = useState('');
  const [nseverity, setNseverity] = useState<'block' | 'warn'>('block');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  // Pattern queued for deletion via the type-to-confirm dialog.
  const [pendingDelete, setPendingDelete] = useState<ExfilPattern | null>(null);

  // Client-side compile error for the regex field (null when valid/empty).
  const regexError = validateRegex(nregex);

  function load() {
    api.get<{ patterns: ExfilPattern[] }>('/dlp/patterns')
      .then((d) => setPatterns(d.patterns))
      .catch((err) => toast(err instanceof Error ? err.message : 'Failed to load patterns', 'error'))
      .finally(() => setLoading(false));
  }

  // Read the exfil-guard kill switches so the page can tell the truth when
  // outbound scanning is off. Fail soft: if the list cannot be read we just
  // omit the banners rather than blanking the page.
  function loadKillSwitches() {
    api.get<{ switches: KillSwitch[] }>('/kill-switches')
      .then((d) => {
        const find = (name: string) => d.switches.find((s) => s.name === name)?.active === true;
        setGuardOff(find('exfil_guard_disabled'));
        setCustomPatternsOff(find('exfil_custom_patterns_disabled'));
        setGuardUnknown(false);
      })
      // Fail CLOSED for a security indicator: a read failure means we cannot
      // confirm the guard is on, so flag it unknown rather than rendering the
      // protected state.
      .catch(() => setGuardUnknown(true));
  }

  useEffect(() => { load(); loadKillSwitches(); }, []);

  async function scan() {
    if (!sample.trim()) return;
    setScanning(true);
    setResult(null);
    try {
      const r = await api.post<ScanResult>('/dlp/test', { text: sample });
      setResult(r);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Scan failed', 'error');
    }
    setScanning(false);
  }

  async function addPattern() {
    if (!nid.trim() || !nname.trim() || !nregex.trim()) return;
    // Hard gate on the client-side compile test so an invalid regex never
    // round-trips to the server.
    if (regexError) {
      toast(`Invalid regex: ${regexError}`, 'error');
      return;
    }
    setAdding(true);
    try {
      await api.post('/dlp/patterns', {
        id: nid.trim(),
        name: nname.trim(),
        regex: nregex,
        severity: nseverity,
      });
      toast(`Pattern "${nname.trim()}" saved`, 'success');
      setNid(''); setNname(''); setNregex(''); setNseverity('block');
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to save pattern', 'error');
    }
    setAdding(false);
  }

  async function removePattern(id: string) {
    setRemoving(id);
    try {
      await api.del(`/dlp/patterns/${encodeURIComponent(id)}`);
      toast('Pattern removed', 'success');
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to remove pattern', 'error');
    } finally {
      setRemoving(null);
      setPendingDelete(null);
    }
  }

  const blockCount = patterns.filter((p) => p.severity === 'block').length;
  const warnCount = patterns.filter((p) => p.severity === 'warn').length;
  const customCount = patterns.filter((p) => p.builtin === false).length;

  return (
    <div>
      <div class="mb-6">
        <h1 data-tour="dlp-title" class="text-display-sm text-primary font-bold">DLP & Exfil Guard</h1>
        <p class="text-body-sm text-secondary mt-1">
          Data-loss prevention patterns scanned on outbound agent content.
          {!loading && ` ${patterns.length} active (${blockCount} block, ${warnCount} warn, ${customCount} custom).`}
        </p>
      </div>

      {guardUnknown && (
        <div class="mb-6 rounded-xl border border-border bg-bg-elevated p-4" role="alert">
          <p class="text-body-sm font-semibold text-primary">Guard state unknown</p>
          <p class="text-caption text-secondary mt-1">
            The exfil-guard kill-switch state could not be read, so this page cannot confirm outbound scanning is
            active. Do not treat the patterns below or a "Clean" scan result as proof of protection until this
            resolves. You may lack the kill-switch read permission.
          </p>
        </div>
      )}

      {guardOff && (
        <div data-tour="dlp-guard-banner" class="mb-6 rounded-xl border border-danger bg-danger/10 p-4" role="alert">
          <p class="text-body-sm font-semibold text-danger">Exfil guard is OFF. Outbound scanning is disabled.</p>
          <p class="text-caption text-secondary mt-1">
            The exfil_guard_disabled kill switch is tripped, so outbound agent content is not being scanned against
            any of these patterns. A "Clean" scan result below does not mean content is being blocked in production.
            Nothing is. Re-enable the guard on the Kill Switches page to restore protection.
          </p>
        </div>
      )}

      {customPatternsOff && (
        <div class="mb-6 rounded-xl border border-warning bg-warning/10 p-4" role="alert">
          <p class="text-body-sm font-semibold text-warning">Custom patterns are not being enforced</p>
          <p class="text-caption text-secondary mt-1">
            The exfil_custom_patterns_disabled kill switch is tripped. Built-in patterns still run, but the custom
            patterns listed below are not applied to outbound content until the switch is cleared.
          </p>
        </div>
      )}

      <section data-tour="dlp-patterns" class="mb-8">
        <h2 class="text-heading-sm font-semibold text-secondary mb-4 uppercase tracking-wider">Active patterns</h2>
        {loading ? (
          <div class="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} height="44px" width="100%" />
            ))}
          </div>
        ) : patterns.length === 0 ? (
          <div class="bg-surface border border-border rounded-xl p-5 text-body-sm text-muted">
            No patterns active. The exfil guard may be disabled via a kill switch.
          </div>
        ) : (
          <div class="bg-surface border border-border rounded-xl overflow-hidden">
            <div class="overflow-x-auto"><table class="w-full text-body-sm">
              <thead>
                <tr class="border-b border-border text-left text-caption text-muted uppercase tracking-wider">
                  <th class="px-4 py-2 font-medium">Pattern</th>
                  <th class="px-4 py-2 font-medium">Source</th>
                  <th class="px-4 py-2 font-medium">Severity</th>
                  <th class="px-4 py-2 font-medium">Regex</th>
                  <th class="px-4 py-2 font-medium w-px"></th>
                </tr>
              </thead>
              <tbody>
                {patterns.map((p) => (
                  <tr key={p.id} class="border-b border-border last:border-0">
                    <td class="px-4 py-2.5 text-primary font-medium">{p.name}</td>
                    <td class="px-4 py-2.5">
                      <Badge variant={p.builtin === false ? 'info' : 'muted'}>
                        {p.builtin === false ? 'custom' : 'built-in'}
                      </Badge>
                    </td>
                    <td class="px-4 py-2.5">
                      <Badge variant={p.severity === 'block' ? 'danger' : 'warning'}>{p.severity}</Badge>
                    </td>
                    <td class="px-4 py-2.5 font-mono text-caption text-secondary truncate max-w-[360px]" title={p.regex}>{p.regex}</td>
                    <td class="px-4 py-2.5 text-right">
                      {p.builtin === false && (
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={removing === p.id}
                          disabled={removing !== null}
                          onClick={() => setPendingDelete(p)}
                        >
                          Remove
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        )}
      </section>

      <section data-tour="dlp-add" class="mb-8">
        <h2 class="text-heading-sm font-semibold text-secondary mb-4 uppercase tracking-wider">Add a custom pattern</h2>
        <div class="bg-surface border border-border rounded-xl p-5">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label class="flex items-center gap-1 text-caption text-secondary font-medium mb-1">
                ID
                <InfoTooltip text="Stable internal identifier for this pattern. 2-64 chars: lowercase letters, digits, _ or -. Used in audit logs and to delete the pattern later." />
              </label>
              <input
                value={nid}
                onInput={(e) => setNid((e.target as HTMLInputElement).value)}
                placeholder="internal_ticket_id"
                class="w-full bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm font-mono text-primary placeholder:text-muted outline-none focus:ring-1 focus:ring-accent"
              />
              <p class="text-overline text-muted mt-1">lowercase, digits, _ or -</p>
            </div>
            <div>
              <label class="flex items-center gap-1 text-caption text-secondary font-medium mb-1">
                Name
                <InfoTooltip text="Human-readable label shown in the patterns table and in scan results. Make it descriptive enough to recognize at a glance." />
              </label>
              <input
                value={nname}
                onInput={(e) => setNname((e.target as HTMLInputElement).value)}
                placeholder="Internal Ticket ID"
                class="w-full bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm text-primary placeholder:text-muted outline-none focus:ring-1 focus:ring-accent"
              />
            </div>
          </div>
          <div class="mt-4">
            <label class="flex items-center gap-1 text-caption text-secondary font-medium mb-1">
              Regex
              <InfoTooltip text="The regular expression matched against outbound content. It is compiled case-insensitively and globally (like /.../gi). It must compile as valid JavaScript regex syntax before it can be saved." />
            </label>
            <input
              value={nregex}
              onInput={(e) => setNregex((e.target as HTMLInputElement).value)}
              placeholder="ACME-[0-9]{6}"
              aria-invalid={regexError ? 'true' : undefined}
              class={`w-full bg-bg-elevated border rounded-lg px-3 py-2 text-body-sm font-mono text-primary placeholder:text-muted outline-none focus:ring-1 ${
                regexError ? 'border-danger focus:ring-danger' : 'border-border focus:ring-accent'
              }`}
            />
            {regexError && (
              <p class="text-overline text-danger mt-1" role="alert">Invalid regex: {regexError}</p>
            )}
          </div>
          <div class="mt-4 flex items-end justify-between gap-4">
            <div class="w-full max-w-xs">
              <label class="flex items-center gap-1 text-caption text-secondary font-medium mb-1">
                Severity
                <InfoTooltip text="Block hard-fails the response when the pattern matches; nothing is sent. Warn only logs the match and lets the content through. Pick Block to stop exfiltration, Warn to observe first." />
              </label>
              <Select
                value={nseverity}
                onChange={(v) => setNseverity(v as 'block' | 'warn')}
                options={SEVERITY_OPTIONS}
              />
            </div>
            <Button
              loading={adding}
              disabled={!nid.trim() || !nname.trim() || !nregex.trim() || regexError !== null}
              onClick={addPattern}
            >
              Save pattern
            </Button>
          </div>
          <p class="text-caption text-muted mt-3">
            Custom patterns apply across all workers within about 30 seconds. They are additive to the built-in set
            and can be disabled in bulk via the exfil_custom_patterns_disabled kill switch.
          </p>
        </div>
      </section>

      <section data-tour="dlp-test">
        <h2 class="text-heading-sm font-semibold text-secondary mb-4 uppercase tracking-wider">Test a payload</h2>
        <div class="bg-surface border border-border rounded-xl p-5 max-w-2xl">
          <textarea
            value={sample}
            onInput={(e) => setSample((e.target as HTMLTextAreaElement).value)}
            placeholder="Paste text to scan against the active patterns..."
            rows={6}
            class="w-full bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm font-mono text-primary placeholder:text-muted outline-none focus:ring-1 focus:ring-accent resize-y"
          />
          <div class="flex items-center justify-between mt-3">
            <span class="text-caption text-muted">{sample.length} chars</span>
            <Button size="sm" loading={scanning} disabled={!sample.trim()} onClick={scan}>Scan</Button>
          </div>

          {result && (
            <div class="mt-4 pt-4 border-t border-border">
              <div class="flex items-center gap-2 mb-3">
                {/* When the guard is OFF a non-blocked result is not "Clean" in
                    any meaningful sense (nothing is scanning in production), so
                    do not paint it green. */}
                <Badge variant={result.blocked ? 'danger' : (guardOff || guardUnknown) ? 'warning' : 'success'}>
                  {result.blocked
                    ? 'Would be blocked'
                    : guardOff
                      ? 'No match (guard OFF, not enforced)'
                      : guardUnknown
                        ? 'No match (guard state unverified)'
                        : 'Clean'}
                </Badge>
                <span class="text-caption text-muted">
                  {result.scannedBytes} bytes scanned{result.truncated ? ', truncated' : ''}
                </span>
              </div>
              {guardOff && (
                <p class="text-caption text-warning mb-2">
                  This is a preview against the pattern set only. The exfil guard is disabled, so this content would
                  not actually be scanned or blocked on outbound agent traffic right now.
                </p>
              )}
              {result.matches.length === 0 ? (
                <p class="text-caption text-muted">No patterns matched.</p>
              ) : (
                <ul class="space-y-1.5">
                  {result.matches.map((m, i) => (
                    <li key={i} class="flex items-center gap-2 text-caption">
                      <span class="inline-flex items-center gap-1">
                        <Badge variant={m.severity === 'block' ? 'danger' : 'warning'}>{m.severity}</Badge>
                        <InfoTooltip term={m.severity} />
                      </span>
                      <span class="text-primary font-medium">{m.patternName}</span>
                      <span class="font-mono text-muted">{m.snippet}</span>
                    </li>
                  ))}
                </ul>
              )}

              <div class="mt-4">
                <RawJsonBlock
                  title="Scan result"
                  data={result as unknown as Record<string, unknown>}
                  fields={[
                    {
                      key: 'blocked',
                      label: 'Outcome',
                      render: (v) => (
                        <Badge variant={v ? 'danger' : (guardOff || guardUnknown) ? 'warning' : 'success'}>
                          {v ? 'Would be blocked' : guardOff ? 'No match (guard OFF)' : guardUnknown ? 'No match (unverified)' : 'Clean'}
                        </Badge>
                      ),
                    },
                    { key: 'matches', label: 'Matches', render: (v) => String((v as unknown[])?.length ?? 0) },
                    { key: 'scannedBytes', label: 'Bytes scanned' },
                    { key: 'truncated', label: 'Truncated' },
                  ]}
                />
              </div>
            </div>
          )}
        </div>
      </section>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete custom pattern"
        message={
          pendingDelete
            ? `This permanently removes "${pendingDelete.name}" from the exfil guard. It stops scanning outbound content within about 30 seconds across all workers. Built-in patterns are unaffected.`
            : ''
        }
        confirmPhrase="DELETE"
        confirmLabel="Delete pattern"
        danger
        onConfirm={() => { if (pendingDelete) removePattern(pendingDelete.id); }}
        onCancel={() => { if (removing === null) setPendingDelete(null); }}
      />
    </div>
  );
}
