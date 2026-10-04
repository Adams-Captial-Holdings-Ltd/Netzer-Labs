import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../../lib/api';
import { toast } from '../../components/Toast';
import { copy, errorCode, workMessage } from './messages';
import type { ApprovalDetail as ApprovalData } from './shared';

export type Decision = 'approve' | 'reject' | 'request_changes';
export const MAX_COMMENT = 4000;
// Refusals that happen before the engine records anything. Any other failure has an unknown outcome.
const refusedBeforeDecision = new Set([
  'comment_required', 'comment_too_long', 'body_too_large', 'not_an_approver',
  'class_not_entitled', 'approver_inactive', 'no_user_session', 'forbidden',
  'not_found', 'not_a_netzer_approval', 'not_pending', 'stale_payload',
  'payload_unavailable', 'payload_mismatch', 'work_disabled', 'paperclip_disabled',
  'paperclip_unavailable', 'key_unavailable', 'paperclip_rejected',
]);
const isOpen = (a: ApprovalData) => a.status === 'pending' && a.canDecide && a.payload.state === 'verified';
// The approval is no longer waiting, so what it now is has to be read again and shown.
const noLongerWaiting = new Set(['not_pending', 'paperclip_rejected']);

export function useApprovalDecision(
  a: ApprovalData | undefined,
  path: string,
  replace: (value: { approval: ApprovalData }) => void,
) {
  const [comment, setComment] = useState('');
  // Which decision is on its way, so only that button shows it.
  const [sending, setSending] = useState<Decision | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [notice, setNotice] = useState('');
  // A notice is an error (decide failed, outcome unknown) or plain information.
  const [noticeIsError, setNoticeIsError] = useState(false);
  const [unknownOutcome, setUnknownOutcome] = useState(false);
  const [mine, setMine] = useState<Decision | null>(null);
  const [locked, setLocked] = useState(false);
  // Text for the persistent status region. It carries the announcement only; an error notice is its own alert.
  const [statusText, setStatusText] = useState('');
  const active = useRef(true);
  useEffect(() => () => { active.current = false; }, []);
  const resultRef = useRef<HTMLElement>(null);
  // The visible "Sending" line. Focus goes there after the confirm closes, so it does not vanish.
  const sendingRef = useRef<HTMLParagraphElement>(null);
  const fromConfirm = useRef(false);
  useEffect(() => {
    if (sending && fromConfirm.current) sendingRef.current?.focus();
  }, [sending, sendingRef]);
  useEffect(() => {
    if (notice || mine) resultRef.current?.focus();
  }, [notice, mine, a]);
  const ready = comment.trim().length > 0 && comment.length <= MAX_COMMENT;

  async function reread(): Promise<ApprovalData | null> {
    try {
      const fresh = await api.get<{ approval: ApprovalData }>(`/work${path}?_=${Date.now()}`);
      if (!active.current) return null;
      replace(fresh);
      return fresh.approval;
    } catch {
      return null;
    }
  }

  async function decide(decision: Decision) {
    if (
      sending || locked || !a?.canDecide || a.payload.state !== 'verified' ||
      (decision !== 'approve' && !ready) || comment.length > MAX_COMMENT
    )
      return;
    fromConfirm.current = decision === 'approve';
    setConfirm(false);
    setSending(decision);
    // From the confirm, focus lands on the visible "Sending" line, which says it; otherwise announce it.
    setStatusText(fromConfirm.current ? '' : copy.announce.sending);
    setNotice('');
    setUnknownOutcome(false);
    try {
      await api.post(`/work${path}/decision`, {
        decision,
        comment: comment.trim() || undefined,
        payloadSha256: a.payloadSha256,
      });
      if (!active.current) return;
      // A confirmed POST is a decision even if the follow-up read is down.
      setMine(decision);
      setStatusText(copy.announce.recorded);
      const fresh = await reread();
      if (!active.current) return;
      if (!fresh) {
        setNoticeIsError(false);
        setNotice(copy.result.recordedNoRead);
      }
    } catch (e) {
      if (!active.current) return;
      const code = errorCode(e);
      const mismatch = code === 'attribution_mismatch';
      const unknown = !refusedBeforeDecision.has(code) && !mismatch;
      const gone = noLongerWaiting.has(code);
      setNoticeIsError(true);
      setNotice(unknown ? workMessage('decision_outcome_unknown') : workMessage(e));
      setUnknownOutcome(unknown);
      setStatusText('');
      if (!(unknown || mismatch || gone || code === 'stale_payload')) return;
      setLocked(true);
      const fresh = await reread();
      if (!active.current || mismatch) return;
      if (!fresh) {
        // The refusal says it is no longer waiting, but that could not be confirmed: say so and offer a check.
        if (gone) {
          setNotice(workMessage('decision_outcome_unknown'));
          setUnknownOutcome(true);
        }
        return;
      }
      if (fresh.status !== 'pending') {
        // It was decided. The page now shows the result; only a refusal keeps its sentence above it.
        if (!gone) setNotice('');
        setUnknownOutcome(false);
        return;
      }
      if (!isOpen(fresh)) return;
      setLocked(false);
      if (unknown) {
        setNoticeIsError(false);
        setNotice(copy.result.checkedPending);
        setUnknownOutcome(false);
      }
    } finally {
      if (active.current) setSending(null);
    }
  }

  // Reads the approval again. The typed comment is held here, so it stays.
  async function checkAgain() {
    const fresh = await reread();
    if (!active.current) return;
    if (!fresh) {
      toast(copy.result.checkFailed, 'error');
      return;
    }
    setUnknownOutcome(false);
    setStatusText(copy.announce.checked);
    setNoticeIsError(false);
    setNotice(fresh.status === 'pending' ? copy.result.checkedPending : '');
    if (fresh.status === 'pending') setLocked(!isOpen(fresh));
  }

  return {
    comment, setComment, sending, locked, confirm, setConfirm, notice, noticeIsError, unknownOutcome, mine,
    resultRef, sendingRef, statusText, decide, checkAgain,
  };
}
