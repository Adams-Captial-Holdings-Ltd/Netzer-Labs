import type { ComponentChildren, RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { CircleAlert, Info } from 'lucide-preact';
import { Button } from '../../components/Button';
import { copy, workMessage } from './messages';
import { MAX_COMMENT, type Decision } from './useApprovalDecision';
import type { ApprovalDetail as ApprovalData } from './shared';

const COUNTER_FROM = 3500;
export const DECIDE_FORM_ID = 'decide-form';

/** What the last decide attempt came to. An error is one alert row; plain information is the same row, calm. */
export function DecideNotice({
  text,
  isError,
  noticeRef,
  onCheckAgain,
}: {
  text: string;
  isError: boolean;
  noticeRef: RefObject<HTMLElement> | null;
  onCheckAgain?: () => void;
}) {
  const Icon = isError ? CircleAlert : Info;
  return (
    <section
      ref={noticeRef}
      tabIndex={-1}
      role={isError ? 'alert' : undefined}
      class={`mb-3 flex items-start gap-3 rounded-lg p-3 text-body-sm
        ${isError ? 'bg-danger-dim text-danger-text' : 'bg-bg-sunken text-primary'}`}
    >
      <Icon size={16} aria-hidden="true" class="mt-1 shrink-0" />
      <div class="min-w-0">
        <p class="break-words">{text}</p>
        {onCheckAgain && (
          <Button size="lg" variant="secondary" onClick={onCheckAgain} class="mt-3">
            {copy.result.checkAgain}
          </Button>
        )}
      </div>
    </section>
  );
}

export function DecideForm({
  approval: a,
  comment,
  setComment,
  sending,
  locked,
  notice,
  noteRef,
  onApprove,
  onDecide,
}: {
  approval: ApprovalData;
  comment: string;
  setComment: (value: string) => void;
  sending: Decision | null;
  locked: boolean;
  /** The notice for the last attempt, shown directly above the buttons. */
  notice: ComponentChildren;
  noteRef: RefObject<HTMLParagraphElement>;
  onApprove: () => void;
  onDecide: (decision: Decision) => void;
}) {
  const hasComment = comment.trim().length > 0;
  const tooLong = comment.length > MAX_COMMENT;
  const ready = hasComment && !tooLong;
  const busy = sending !== null || locked;
  const commentRef = useRef<HTMLTextAreaElement>(null);
  // Set when Reject or Request changes is used with no comment; cleared as soon as the person types.
  const [asked, setAsked] = useState(false);
  const missingComment = asked && !hasComment;
  const invalid = tooLong || missingComment;
  const counterBand = tooLong ? 2 : comment.length >= COUNTER_FROM ? 1 : 0;
  const previousBand = useRef(0);
  const [counterAnnouncement, setCounterAnnouncement] = useState('');
  useEffect(() => {
    if (counterBand !== previousBand.current) {
      setCounterAnnouncement(counterBand === 2 ? copy.decide.counterOver
        : counterBand === 1 ? copy.decide.counterShown : '');
      previousBand.current = counterBand;
    }
  }, [counterBand]);
  const reason = busy ? 'decide-note' : !ready ? 'comment-hint' : undefined;
  const decideWithComment = (decision: Decision) => {
    if (busy) return;
    if (ready) onDecide(decision);
    else {
      setAsked(true);
      commentRef.current?.focus();
    }
  };
  return (
    <form
      id={DECIDE_FORM_ID}
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy && !tooLong) onApprove();
      }}
      class="mb-8 max-w-measure"
    >
      <label for="work-comment" class="block text-body-sm text-primary mb-2">
        {copy.decide.comment}
      </label>
      <textarea
        id="work-comment"
        ref={commentRef}
        aria-describedby="comment-hint"
        aria-invalid={invalid ? 'true' : undefined}
        value={comment}
        onInput={(e) => {
          setComment(e.currentTarget.value);
          setAsked(false);
        }}
        rows={4}
        class="w-full rounded-lg border border-border bg-surface text-primary p-3
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      />
      {/* The height is reserved, so the buttons never move when the helper changes. */}
      <div class="flex justify-between gap-4 min-h-10 mt-1">
        <p id="comment-hint" class={`text-caption ${invalid ? 'text-danger-text' : 'text-secondary'}`}>
          {tooLong ? workMessage('comment_too_long')
            : missingComment ? workMessage('comment_required') : copy.decide.helper}
        </p>
        {comment.length >= COUNTER_FROM && (
          <p class="text-caption text-secondary tabular-nums shrink-0" aria-hidden="true">
            {copy.decide.counter(comment.length)}
          </p>
        )}
      </div>
      <span role="status" class="sr-only">{counterAnnouncement}</span>
      <p class="text-body-sm text-primary mt-2">
        {copy.decide.deciding(a.decisionLabel, a.caseTitle ?? a.caseKey)}
      </p>
      <p class="text-body-sm text-secondary mt-1 mb-4">{copy.decide.consequences}</p>
      {notice}
      <div class="flex flex-col md:flex-row gap-6">
        <Button
          size="lg"
          type="submit"
          loading={sending === 'approve'}
          aria-disabled={busy || tooLong}
          aria-describedby={busy ? 'decide-note' : tooLong ? 'comment-hint' : undefined}
          class="w-full md:w-auto"
        >
          {copy.decide.approve}
        </Button>
        <Button
          size="lg"
          variant="secondary"
          loading={sending === 'request_changes'}
          aria-disabled={busy || tooLong}
          aria-describedby={reason}
          onClick={() => decideWithComment('request_changes')}
          class="w-full md:w-auto"
        >
          {copy.decide.requestChanges}
        </Button>
        <Button
          size="lg"
          variant="danger-outline"
          loading={sending === 'reject'}
          aria-disabled={busy || tooLong}
          aria-describedby={reason}
          onClick={() => decideWithComment('reject')}
          class="w-full md:w-auto"
        >
          {copy.decide.reject}
        </Button>
      </div>
      <p id="decide-note" ref={noteRef} tabIndex={-1} class="text-caption text-secondary mt-3 min-h-6">
        {sending ? copy.decide.sendingNote : locked ? copy.decide.lockedNote : ''}
      </p>
    </form>
  );
}
