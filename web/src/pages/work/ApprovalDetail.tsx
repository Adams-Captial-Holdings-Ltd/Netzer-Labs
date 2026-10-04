import { Link, useRoute } from 'wouter-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../../lib/api';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { toast } from '../../components/Toast';
import {
  RelativeTime,
  WorkError,
  WorkLoading,
  WorkStatus,
  words,
  type ApprovalDetail as ApprovalData,
  useWork,
} from './shared';
import { workMessage } from './messages';

type Decision = 'approve' | 'reject' | 'request_changes';
const decisionWords: Record<Decision, string> = {
  approve: 'Approved',
  reject: 'Rejected',
  request_changes: 'Changes requested',
};
const payloadScrollLimit = 'max-h-[480px]';
function isFlat(value: unknown): value is Record<string, string | number | boolean | null> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v))
  );
}
function PayloadBlock({ value }: { value: unknown }) {
  if (isFlat(value))
    return (
      <dl
        class={`${payloadScrollLimit} overflow-auto rounded-lg border border-border bg-bg-sunken divide-y divide-border`}
      >
        {Object.entries(value).map(([key, val]) => (
          <div key={key} class="grid sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)] gap-2 p-3 text-body-sm">
            <dt class="text-secondary">{words(key)}</dt>
            <dd class="text-primary whitespace-pre-wrap break-words min-w-0">{String(val ?? '—')}</dd>
          </div>
        ))}
      </dl>
    );
  return (
    <pre
      class={`${payloadScrollLimit} overflow-auto rounded-lg border border-border bg-bg-sunken p-4
      font-mono text-caption text-primary whitespace-pre-wrap break-words`}
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function ApprovalHeader({ approval: a }: { approval: ApprovalData }) {
  return (
    <header class="mt-4 mb-8">
      <h1 class="text-heading-lg text-primary break-words">
        {a.decisionLabel} for {a.caseTitle ?? <span class="font-mono">{a.caseKey}</span>}
      </h1>
      <div class="flex flex-wrap gap-3 items-center mt-2 text-body-sm text-secondary">
        <WorkStatus status={a.status} />
        <span>{a.stageName ?? a.stage}</span>
        <RelativeTime value={a.requestedAt} />
        {a.caseId && (
          <Link
            class="text-primary underline focus-visible:ring-2 focus-visible:ring-primary"
            href={`/work/cases/${encodeURIComponent(a.caseId)}`}
          >
            View case
          </Link>
        )}
      </div>
    </header>
  );
}

function ApprovalPayload({ approval: a }: { approval: ApprovalData }) {
  return (
    <section class="mb-8">
      <h2 class="text-heading-sm text-primary mb-3">What will be done</h2>
      {a.payload.state === 'verified' ? (
        <>
          <PayloadBlock value={a.payload.value} />
          <details class="mt-3 text-caption text-secondary">
            <summary class="cursor-pointer focus-visible:ring-2 focus-visible:ring-primary">
              Verification code
            </summary>
            <p class="font-mono break-all mt-2">{a.payloadSha256}</p>
          </details>
        </>
      ) : (
        <p class="text-body-sm text-secondary">
          We cannot show what would be approved, so it cannot be decided.
        </p>
      )}
    </section>
  );
}

function DecisionResult({
  approval: a,
  mine,
  notice,
  resultRef,
}: {
  approval: ApprovalData;
  mine: Decision | null;
  notice: string;
  resultRef: preact.RefObject<HTMLDivElement>;
}) {
  if (!notice && !mine && a.status === 'pending') return null;
  const verb =
    a.status === 'approved' ? 'approved' : a.status === 'rejected' ? 'rejected' : 'requested changes to';
  const myVerb = mine === 'approve' ? 'approved' : mine === 'reject' ? 'rejected' : 'requested changes to';
  return (
    <div
      ref={resultRef}
      tabIndex={-1}
      role={notice ? 'alert' : 'status'}
      class="text-body-sm text-primary mb-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      {notice || (mine ? `You ${myVerb} this` : `${a.decidedBy ?? 'Someone'} ${verb} this`)}
      {!notice && a.decidedAt && (
        <>
          {' '}
          · <RelativeTime value={a.decidedAt} />
        </>
      )}
      {!notice && a.decisionComment && (
        <p class="whitespace-pre-wrap break-words mt-2">{a.decisionComment}</p>
      )}
      {!notice && (
        <p class="mt-3">
          <Link href="/work" class="text-primary underline focus-visible:ring-2 focus-visible:ring-primary">
            Back to Inbox
          </Link>
        </p>
      )}
    </div>
  );
}

function DecideForm({
  approval: a,
  comment,
  setComment,
  sending,
  onApprove,
  onDecide,
}: {
  approval: ApprovalData;
  comment: string;
  setComment: (value: string) => void;
  sending: boolean;
  onApprove: () => void;
  onDecide: (decision: Decision) => void;
}) {
  const ready = comment.trim().length > 0 && comment.length <= 4000;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onApprove();
      }}
      class="mb-8"
    >
      <label for="work-comment" class="block text-body-sm text-primary mb-2">
        Comment (optional to approve)
      </label>
      <textarea
        id="work-comment"
        value={comment}
        onInput={(e) => setComment(e.currentTarget.value)}
        rows={4}
        class="w-full rounded-lg border border-border bg-surface text-primary p-3
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      />
      {comment.length >= 3500 && (
        <p class="text-caption text-secondary" role="status">
          {comment.length} / 4 000 characters
        </p>
      )}
      <p class="text-body-sm text-secondary my-4">
        You are deciding {a.decisionLabel} for {a.caseTitle ?? a.caseKey}. This cannot be undone.
      </p>
      {!ready && (
        <p id="comment-hint" class="text-caption text-secondary mb-3">
          {comment.length > 4000
            ? 'The comment is too long (4 000 characters at most).'
            : 'Add a comment to reject or request changes'}
        </p>
      )}
      <DecisionButtons ready={ready} sending={sending} tooLong={comment.length > 4000} onDecide={onDecide} />
    </form>
  );
}

function DecisionButtons({
  ready,
  sending,
  tooLong,
  onDecide,
}: {
  ready: boolean;
  sending: boolean;
  tooLong: boolean;
  onDecide: (decision: Decision) => void;
}) {
  return (
    <div class="flex flex-col md:flex-row gap-6">
      <Button size="lg" type="submit" loading={sending} disabled={tooLong} class="w-full md:w-auto">
        Approve
      </Button>
      <Button
        size="lg"
        variant="secondary"
        disabled={sending}
        aria-disabled={!ready}
        aria-describedby={!ready ? 'comment-hint' : undefined}
        onClick={() => onDecide('request_changes')}
        class="w-full md:w-auto"
      >
        Request changes
      </Button>
      <Button
        size="lg"
        variant="danger-outline"
        disabled={sending}
        aria-disabled={!ready}
        aria-describedby={!ready ? 'comment-hint' : undefined}
        onClick={() => onDecide('reject')}
        class="w-full md:w-auto"
      >
        Reject
      </Button>
    </div>
  );
}
function useApprovalDecision(
  a: ApprovalData | undefined,
  path: string,
  reload: () => void,
  replace: (value: { approval: ApprovalData }) => void,
) {
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [notice, setNotice] = useState('');
  const [mine, setMine] = useState<Decision | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (notice || mine) resultRef.current?.focus();
  }, [notice, mine, a]);
  const ready = comment.trim().length > 0 && comment.length <= 4000;
  async function decide(decision: Decision) {
    if (
      sending ||
      !a?.canDecide ||
      a.payload.state !== 'verified' ||
      (decision !== 'approve' && !ready) ||
      comment.length > 4000
    )
      return;
    setConfirm(false);
    setSending(true);
    setNotice('');
    try {
      await api.post(`/work${path}/decision`, {
        decision,
        comment: comment.trim() || undefined,
        payloadSha256: a.payloadSha256,
      });
      // A confirmed POST is a decision even if the follow-up read is down.
      setMine(decision);
      toast(decisionWords[decision], 'success');
      try {
        const fresh = await api.get<{ approval: ApprovalData }>(`/work${path}?_=${Date.now()}`);
        replace(fresh);
      } catch {
        setNotice('The decision was recorded. Reload to see the latest approval.');
      }
    } catch (e) {
      setNotice(workMessage(e));
      if (e instanceof Error && e.message === 'stale_payload') reload();
    } finally {
      setSending(false);
    }
  }
  return { comment, setComment, sending, confirm, setConfirm, notice, mine, resultRef, decide };
}

export function ApprovalDetail() {
  const [, params] = useRoute('/work/approvals/:approvalId');
  const path = `/approvals/${encodeURIComponent(params?.approvalId ?? '')}`;
  const { data, error, loading, reload, replace } = useWork<{ approval: ApprovalData }>(path);
  const a = data?.approval;
  const { comment, setComment, sending, confirm, setConfirm, notice, mine, resultRef, decide } =
    useApprovalDecision(a, path, reload, replace);
  if (loading) return <WorkLoading detail />;
  if ((error && !data) || !a) return <WorkError error={error} retry={reload} back="/work/approvals" />;
  return (
    <div class="max-w-3xl min-w-0">
      <Link
        href="/work/approvals"
        class="text-body-sm text-primary underline focus-visible:ring-2 focus-visible:ring-primary"
      >
        Back to Approvals
      </Link>
      <ApprovalHeader approval={a} />
      <ApprovalPayload approval={a} />
      <DecisionResult approval={a} mine={mine} notice={notice} resultRef={resultRef} />
      {!mine && a.canDecide && a.payload.state === 'verified' ? (
        <DecideForm
          approval={a}
          comment={comment}
          setComment={setComment}
          sending={sending}
          onApprove={() => setConfirm(true)}
          onDecide={decide}
        />
      ) : (
        !mine &&
        a.status === 'pending' &&
        a.payload.state === 'verified' && (
          <p class="text-body-sm text-secondary">{workMessage(a.cannotDecideReason)}</p>
        )
      )}
      <ConfirmDialog
        open={confirm}
        title={`Approve ${a.decisionLabel}`}
        message={`Approve ${a.decisionLabel} for ${a.caseKey}? This cannot be undone.`}
        confirmLabel="Approve"
        onConfirm={() => decide('approve')}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
}
