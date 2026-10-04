import { useEffect, useRef, useState } from 'preact/hooks';
import { Button } from '../../components/Button';
import { copy, workMessage } from './messages';
import { MAX_COMMENT, type Decision } from './useApprovalDecision';
import type { ApprovalDetail as ApprovalData } from './shared';

const COUNTER_FROM = 3500;

export function DecideForm({
  approval: a,
  comment,
  setComment,
  sending,
  locked,
  onApprove,
  onDecide,
}: {
  approval: ApprovalData;
  comment: string;
  setComment: (value: string) => void;
  sending: Decision | null;
  locked: boolean;
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
  const invalid = tooLong || (asked && !hasComment);
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
          {tooLong ? workMessage('comment_too_long') : copy.decide.helper}
        </p>
        {comment.length >= COUNTER_FROM && (
          <p class="text-caption text-secondary tabular-nums shrink-0" aria-hidden="true">
            {copy.decide.counter(comment.length)}
          </p>
        )}
      </div>
      <span role="status" class="sr-only">{counterAnnouncement}</span>
      <p class="text-body-sm text-secondary mt-2">
        {copy.decide.deciding(a.decisionLabel, a.caseTitle ?? a.caseKey)}
      </p>
      <p class="text-body-sm text-secondary mt-1 mb-4">{copy.decide.consequences}</p>
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
          aria-disabled={busy || !ready}
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
          aria-disabled={busy || !ready}
          aria-describedby={reason}
          onClick={() => decideWithComment('reject')}
          class="w-full md:w-auto"
        >
          {copy.decide.reject}
        </Button>
      </div>
      <p id="decide-note" class="text-caption text-secondary mt-3 min-h-6">
        {sending ? copy.decide.sendingNote : locked ? copy.decide.lockedNote : ''}
      </p>
    </form>
  );
}
