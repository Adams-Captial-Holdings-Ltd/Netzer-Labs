import { Link, useRoute } from 'wouter-preact';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import {
  HeaderStatus,
  PageTitle,
  RelativeTime,
  WorkError,
  WorkLoading,
  linkClass,
  words,
  type ApprovalDetail as ApprovalData,
  useWork,
} from './shared';
import { copy, workMessage } from './messages';
import { DecideForm } from './DecideForm';
import { useApprovalDecision, type Decision } from './useApprovalDecision';

function isFlat(value: unknown): value is Record<string, string | number | boolean | null> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v))
  );
}
// Below md the page scrolls, so the person passes all of it. From md up the box scrolls (cap in
// tailwind.config.ts) and is a keyboard stop, so a keyboard user can scroll it too.
export function PayloadBlock({ value }: { value: unknown }) {
  return (
    <div
      role="region"
      aria-label={copy.payload.region}
      tabIndex={0}
      class="overflow-auto md:max-h-payload rounded-lg border border-border bg-bg-sunken"
    >
      {isFlat(value) ? (
        <dl class="divide-y divide-border">
          {Object.entries(value).map(([key, val]) => (
            <div key={key} class="grid sm:grid-cols-payload-row gap-2 p-3 text-body-sm">
              <dt class="text-secondary break-words">{words(key)}</dt>
              <dd class="text-primary whitespace-pre-wrap break-words min-w-0 tabular-nums">{String(val ?? '—')}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <pre class="p-4 font-mono text-caption text-primary whitespace-pre-wrap break-words">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ApprovalHeader({ approval: a }: { approval: ApprovalData }) {
  return (
    <header class="mt-4 mb-8">
      <h1 class="text-display-sm text-primary font-bold break-words">
        {a.decisionLabel} for {a.caseTitle ?? <span class="font-mono">{a.caseKey}</span>}
      </h1>
      <div class="flex flex-wrap gap-x-3 gap-y-1 items-center mt-2 text-body-sm text-secondary">
        <HeaderStatus status={a.status} />
        <span>{a.stageName ?? a.stage}</span>
        <span>
          {copy.requested} <RelativeTime value={a.requestedAt} />
        </span>
        {a.caseId && (
          <Link class={linkClass} href={`/work/cases/${encodeURIComponent(a.caseId)}`}>
            {copy.detail.viewCase}
          </Link>
        )}
      </div>
    </header>
  );
}

function payloadHeading(a: ApprovalData): string {
  return a.status === 'pending'
    ? copy.payload.ifApproved
    : a.status === 'approved'
      ? copy.payload.wasApproved
      : copy.payload.wasProposed;
}

function ApprovalPayload({ approval: a }: { approval: ApprovalData }) {
  if (a.payload.state !== 'verified')
    return (
      <section class="mb-8 max-w-measure space-y-2 text-body-sm text-secondary">
        <p>{copy.payload.cannotShow}</p>
        <p>{copy.payload.tellAdmin}</p>
      </section>
    );
  return (
    <section class="mb-8">
      <h2 class="text-heading-sm text-primary mb-3">{payloadHeading(a)}</h2>
      <PayloadBlock value={a.payload.value} />
      <p class="text-caption text-secondary mt-3">{copy.payload.fingerprint}</p>
      <p class="font-mono text-caption text-secondary break-all">{a.payloadSha256}</p>
    </section>
  );
}

function outcome(a: ApprovalData, mine: Decision | null): string | null {
  if (mine)
    return mine === 'approve' ? copy.result.approvedMine
      : mine === 'reject' ? copy.result.rejectedMine : copy.result.changesMine;
  if (a.status === 'cancelled') return copy.result.cancelled;
  const who = a.decidedBy ?? copy.result.unknownPerson;
  if (a.status === 'approved') return copy.result.approvedBy(who);
  if (a.status === 'rejected') return copy.result.rejectedBy(who);
  if (a.status === 'revision_requested') return copy.result.changesBy(who);
  return null;
}

function DecisionResult({
  approval: a,
  mine,
  resultRef,
}: {
  approval: ApprovalData;
  mine: Decision | null;
  resultRef: preact.RefObject<HTMLElement> | null;
}) {
  const line = outcome(a, mine);
  if (!line) return null;
  return (
    <section ref={resultRef} tabIndex={-1} aria-labelledby="decision-heading" class="mb-8 max-w-measure">
      <h2 id="decision-heading" class="text-heading-sm text-primary mb-3">{copy.result.heading}</h2>
      <p class="text-body text-primary">{line}</p>
      {a.decidedAt && (
        <p class="text-caption text-secondary mt-1">
          {copy.result.decided} <RelativeTime value={a.decidedAt} />
        </p>
      )}
      {a.decisionComment && (
        <>
          <p class="text-caption text-secondary mt-4">{copy.result.comment}</p>
          <p class="text-body text-primary whitespace-pre-wrap break-words">{a.decisionComment}</p>
        </>
      )}
      <p class="mt-3">
        <Link href="/work" class={linkClass}>
          {copy.detail.backInbox}
        </Link>
      </p>
    </section>
  );
}

export function ApprovalDetail() {
  const [, params] = useRoute('/work/approvals/:approvalId');
  const id = params?.approvalId ?? '';
  return <ApprovalDetailForId key={id} id={id} />;
}

function ApprovalDetailForId({ id }: { id: string }) {
  const path = `/approvals/${encodeURIComponent(id)}`;
  const { data, error, loading, reload, replace } = useWork<{ approval: ApprovalData }>(path);
  const a = data?.approval;
  const d = useApprovalDecision(a, path, replace);
  if (loading || error || !a)
    return (
      <div class="max-w-3xl min-w-0">
        <PageTitle title={copy.detail.approvalTitle} />
        {loading ? (
          <WorkLoading detail />
        ) : (
          <WorkError
            error={error}
            retry={reload}
            notFound={{ title: copy.detail.approvalNotFound, href: '/work/approvals', label: copy.detail.backApprovals }}
          />
        )}
      </div>
    );
  const canDecide = !d.mine && a.canDecide && a.payload.state === 'verified';
  return (
    <div class="max-w-3xl min-w-0">
      <Link href="/work/approvals" class={linkClass}>
        {copy.detail.backApprovals}
      </Link>
      <ApprovalHeader approval={a} />
      <ApprovalPayload approval={a} />
      {d.notice && (
        <section ref={d.resultRef} tabIndex={-1} class="mb-6 max-w-measure text-body-sm text-primary">
          <p>{d.notice}</p>
          {d.unknownOutcome && (
            <Button size="lg" variant="secondary" onClick={d.checkAgain} class="mt-3">
              {copy.result.checkAgain}
            </Button>
          )}
        </section>
      )}
      <DecisionResult approval={a} mine={d.mine} resultRef={d.notice ? null : d.resultRef} />
      {canDecide ? (
        <DecideForm
          approval={a}
          comment={d.comment}
          setComment={d.setComment}
          sending={d.sending}
          locked={d.locked}
          onApprove={() => d.setConfirm(true)}
          onDecide={d.decide}
        />
      ) : (
        !d.mine &&
        a.status === 'pending' &&
        a.payload.state === 'verified' && (
          <p class="text-body-sm text-secondary max-w-measure">
            {workMessage(a.cannotDecideReason ?? 'not_an_approver')}
          </p>
        )
      )}
      <ConfirmDialog
        simple
        open={d.confirm}
        title={copy.confirm.title(a.decisionLabel)}
        message={
          <>
            {copy.confirm.lead(a.decisionLabel)}
            <span class="font-mono">{a.caseKey}</span>
            {copy.confirm.tail}
          </>
        }
        confirmLabel={copy.confirm.approve}
        onConfirm={() => d.decide('approve')}
        onCancel={() => d.setConfirm(false)}
      />
      {/* Persistent live regions. They start empty and carry the announcement only. */}
      <p ref={d.statusRef} role="status" tabIndex={-1} class="sr-only">{d.statusText}</p>
      <p role="alert" class="sr-only">{d.alertText}</p>
    </div>
  );
}
