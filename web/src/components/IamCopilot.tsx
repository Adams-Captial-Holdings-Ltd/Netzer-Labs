import { useState, useEffect } from 'preact/hooks';
import { api, type IamDraftResult, type IamApplyAction } from '../lib/api';
import { toast } from './Toast';
import { Toggle } from './Toggle';

const FINDING_STYLE: Record<string, string> = {
  ERROR: 'text-danger bg-danger/10',
  SECURITY_WARNING: 'text-warning bg-warning/10',
  WARNING: 'text-warning bg-warning/10',
  SUGGESTION: 'text-muted bg-muted/10',
  INFO: 'text-muted bg-muted/10',
};

const ACTION_LABELS: Record<IamApplyAction, string> = {
  create_policy: 'Create managed policy',
  put_role_policy: 'Put inline policy on role',
  attach_role_policy: 'Attach managed policy to role',
  create_user: 'Create user',
  put_user_policy: 'Put inline policy on user',
  attach_user_policy: 'Attach managed policy to user',
};

export function IamCopilot() {
  const [instruction, setInstruction] = useState('');
  const [existing, setExisting] = useState('');
  const [showExisting, setShowExisting] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState<IamDraftResult | null>(null);

  const [applyEnabled, setApplyEnabled] = useState(false);
  const [armBusy, setArmBusy] = useState(false);
  const [action, setAction] = useState<IamApplyAction>('put_role_policy');
  const [roleName, setRoleName] = useState('');
  const [userName, setUserName] = useState('');
  const [policyName, setPolicyName] = useState('');
  const [policyArn, setPolicyArn] = useState('');
  const [allowDangerous, setAllowDangerous] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    api.iam.status().then((s) => setApplyEnabled(s.applyEnabled)).catch(() => {});
  }, []);

  async function runDraft() {
    if (!instruction.trim()) {
      toast('Describe what the policy should do', 'error');
      return;
    }
    setDrafting(true);
    setDraft(null);
    try {
      const r = await api.iam.draft(instruction, showExisting && existing.trim() ? existing : undefined);
      setDraft(r);
      if (!policyName) setPolicyName('cce-drafted-policy');
    } catch (e) {
      toast(`Draft failed: ${e instanceof Error ? e.message : 'error'}`, 'error');
    } finally {
      setDrafting(false);
    }
  }

  async function copyDoc() {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(draft.policyDocument);
      toast('Policy JSON copied', 'success');
    } catch {
      toast('Copy failed', 'error');
    }
  }

  async function toggleApply() {
    const next = !applyEnabled;
    setArmBusy(true);
    try {
      await api.config.set('iam', 'apply_enabled', String(next));
      setApplyEnabled(next);
      toast(next ? 'In-dashboard apply ARMED' : 'In-dashboard apply disarmed', next ? 'info' : 'success');
    } catch (e) {
      toast(`Could not change apply state: ${e instanceof Error ? e.message : 'error'}`, 'error');
    } finally {
      setArmBusy(false);
    }
  }

  async function runApply() {
    if (!draft) return;
    if (!confirm) {
      toast('Tick the confirm box before applying', 'error');
      return;
    }
    setApplying(true);
    try {
      const needsDoc = action === 'create_policy' || action === 'put_role_policy' || action === 'put_user_policy';
      const r = await api.iam.apply({
        action,
        confirm: true,
        allowDangerous,
        ...(needsDoc ? { policyDocument: draft.policyDocument } : {}),
        ...(action.includes('role') ? { roleName } : {}),
        ...(action.includes('user') ? { userName } : {}),
        ...(action === 'attach_role_policy' || action === 'attach_user_policy' ? { policyArn } : {}),
        // needsDoc already covers create_policy, so the extra check was both
        // redundant and a type error (action is narrowed by this point).
        ...(needsDoc ? { policyName } : {}),
      });
      toast(r.detail + (r.arn ? ` (${r.arn})` : ''), 'success');
      setConfirm(false);
    } catch (e) {
      toast(`Apply failed: ${e instanceof Error ? e.message : 'error'}`, 'error');
    } finally {
      setApplying(false);
    }
  }

  const needsRole = action.includes('role');
  const needsUser = action.includes('user');
  const needsArn = action === 'attach_role_policy' || action === 'attach_user_policy';
  const needsName = action === 'create_policy' || action === 'put_role_policy' || action === 'put_user_policy';

  return (
    <div class="bg-surface border border-border rounded-xl p-5 mt-6">
      <div class="flex items-center gap-2 mb-1">
        <svg class="w-4 h-4 text-primary" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 2l1.6 5.2L19 9l-5.4 1.8L12 16l-1.6-5.2L5 9l5.4-1.8L12 2z" />
        </svg>
        <h2 class="text-heading-sm font-semibold">AI Policy Drafter</h2>
      </div>
      <p class="text-body-sm text-secondary mb-4">
        Describe an IAM policy in plain English (or paste one to edit). It's drafted with Bedrock,
        linted for least-privilege, and validated by AWS Access Analyzer. Review before applying.
      </p>

      <textarea
        value={instruction}
        onInput={(e) => setInstruction((e.target as HTMLTextAreaElement).value)}
        rows={3}
        placeholder="e.g. Allow read-only access to the curated S3 bucket and read items from the sessions DynamoDB table."
        class="w-full bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm text-primary outline-none focus:border-primary resize-y"
      />

      <div class="mt-2">
        <button
          onClick={() => setShowExisting((v) => !v)}
          class="text-caption text-muted hover:text-secondary"
        >
          {showExisting ? '− Hide existing policy' : '+ Edit an existing policy'}
        </button>
        {showExisting && (
          <textarea
            value={existing}
            onInput={(e) => setExisting((e.target as HTMLTextAreaElement).value)}
            rows={5}
            placeholder="Paste the current policy JSON to edit it in plain English."
            class="w-full mt-2 bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm text-primary font-mono outline-none focus:border-primary resize-y"
          />
        )}
      </div>

      <button
        onClick={runDraft}
        disabled={drafting}
        class="mt-3 px-4 py-2 text-body-sm rounded-lg font-medium bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-50 transition-colors"
      >
        {drafting ? 'Drafting…' : 'Draft policy'}
      </button>

      {draft && (
        <div class="mt-5 space-y-4">
          {draft.explanation && (
            <p class="text-body-sm text-secondary">
              <span class="font-semibold text-primary">What it does: </span>
              {draft.explanation}
            </p>
          )}

          <div>
            <div class="flex items-center justify-between mb-1">
              <span class="text-caption text-muted uppercase tracking-wider">Policy JSON</span>
              <button onClick={copyDoc} class="text-caption text-primary hover:underline">Copy</button>
            </div>
            <pre class="bg-bg-sunken border border-border rounded-lg p-3 text-caption text-primary font-mono overflow-x-auto max-h-80">{draft.policyDocument}</pre>
          </div>

          {draft.warnings.length > 0 && (
            <div>
              <span class="text-caption text-warning uppercase tracking-wider">Risk lint</span>
              <ul class="mt-1 space-y-1">
                {draft.warnings.map((w, i) => (
                  <li key={i} class="text-body-sm text-warning">• {w}</li>
                ))}
              </ul>
            </div>
          )}

          {draft.findings.length > 0 && (
            <div>
              <span class="text-caption text-muted uppercase tracking-wider">Access Analyzer</span>
              <ul class="mt-1 space-y-1">
                {draft.findings.map((f, i) => (
                  <li key={i} class="flex items-start gap-2 text-body-sm">
                    <span class={`text-overline uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0 ${FINDING_STYLE[f.type] ?? FINDING_STYLE.INFO}`}>
                      {f.type.replace('_', ' ')}
                    </span>
                    <span class="text-secondary">{f.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* How to apply yourself (always shown) */}
          <div>
            <span class="text-caption text-muted uppercase tracking-wider">Apply it yourself</span>
            <pre class="mt-1 bg-bg-sunken border border-border rounded-lg p-3 text-caption text-secondary font-mono overflow-x-auto">{`# save the JSON above to policy.json, then:
aws iam create-policy --policy-name ${policyName || 'NAME'} --policy-document file://policy.json
# or attach inline to a role:
aws iam put-role-policy --role-name ROLE --policy-name ${policyName || 'NAME'} --policy-document file://policy.json`}</pre>
          </div>

          {/* Gated in-dashboard apply */}
          {applyEnabled ? (
            <div class="border-t border-border pt-4">
              <div class="flex items-center justify-between mb-1">
                <span class="text-caption text-primary uppercase tracking-wider">Apply from dashboard · armed</span>
                <Toggle
                  checked
                  tone="danger"
                  busy={armBusy}
                  ariaLabel="In-dashboard apply armed, switch off to disarm"
                  onChange={() => toggleApply()}
                />
              </div>
              <div class="flex flex-wrap gap-2 mt-2">
                <select
                  value={action}
                  onChange={(e) => setAction((e.target as HTMLSelectElement).value as IamApplyAction)}
                  class="bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm text-primary outline-none"
                >
                  {Object.entries(ACTION_LABELS).map(([v, l]) => (
                    <option value={v}>{l}</option>
                  ))}
                </select>
                {needsRole && (
                  <input value={roleName} onInput={(e) => setRoleName((e.target as HTMLInputElement).value)} placeholder="role name"
                    class="bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm text-primary outline-none" />
                )}
                {needsUser && (
                  <input value={userName} onInput={(e) => setUserName((e.target as HTMLInputElement).value)} placeholder="user name"
                    class="bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm text-primary outline-none" />
                )}
                {needsName && (
                  <input value={policyName} onInput={(e) => setPolicyName((e.target as HTMLInputElement).value)} placeholder="policy name"
                    class="bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm text-primary outline-none" />
                )}
                {needsArn && (
                  <input value={policyArn} onInput={(e) => setPolicyArn((e.target as HTMLInputElement).value)} placeholder="policy ARN"
                    class="bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm text-primary outline-none flex-1 min-w-[200px]" />
                )}
              </div>
              <div class="flex items-center gap-4 mt-3 flex-wrap">
                <label class="flex items-center gap-2 text-body-sm text-secondary">
                  <input type="checkbox" checked={confirm} onChange={(e) => setConfirm((e.target as HTMLInputElement).checked)} />
                  I reviewed this and want to apply it to AWS
                </label>
                {draft.warnings.length > 0 && (
                  <label class="flex items-center gap-2 text-body-sm text-warning">
                    <input type="checkbox" checked={allowDangerous} onChange={(e) => setAllowDangerous((e.target as HTMLInputElement).checked)} />
                    Override risk block
                  </label>
                )}
                <button
                  onClick={runApply}
                  disabled={applying || !confirm}
                  class="px-4 py-2 text-body-sm rounded-lg font-medium bg-danger/10 text-danger hover:bg-danger/20 disabled:opacity-50 transition-colors"
                >
                  {applying ? 'Applying…' : 'Apply to AWS'}
                </button>
              </div>
            </div>
          ) : (
            <div class="border-t border-border pt-4">
              <p class="text-caption text-muted mb-2">
                In-dashboard apply is disabled (safe default). Drafting, validation, and the commands
                above all work without it. Arming lets this dashboard write IAM directly.
              </p>
              <Toggle
                checked={false}
                tone="danger"
                busy={armBusy}
                ariaLabel="In-dashboard apply disarmed, switch on to arm"
                onChange={() => toggleApply()}
              >
                <span class="text-body-sm font-medium text-secondary">{armBusy ? 'Arming…' : 'Enable apply (arm)'}</span>
              </Toggle>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
