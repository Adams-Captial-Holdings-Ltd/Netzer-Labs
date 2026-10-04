import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../../lib/api';
import { toast } from '../../components/Toast';
import { copy, workMessage } from './messages';
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
const toastFor = (d: Decision) =>
  d === 'approve' ? copy.result.approvedToast : d === 'reject' ? copy.result.rejectedToast : copy.result.changesToast;

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
  const [unknownOutcome, setUnknownOutcome] = useState(false);
  const [mine, setMine] = useState<Decision | null>(null);
  const [locked, setLocked] = useState(false);
  // Text for the two persistent live regions. They carry the announcement only.
  const [statusText, setStatusText] = useState('');
  const [alertText, setAlertText] = useState('');
  const active = useRef(true);
  useEffect(() => () => { active.current = false; }, []);
  const resultRef = useRef<HTMLElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const fromConfirm = useRef(false);
  useEffect(() => {
    if (sending && fromConfirm.current) statusRef.current?.focus();
  }, [sending, statusRef]);
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
    setStatusText(copy.announce.sending);
    setNotice('');
    setAlertText('');
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
      toast(toastFor(decision), 'success');
      const fresh = await reread();
      if (!active.current) return;
      if (!fresh) setNotice(copy.result.recordedNoRead);
    } catch (e) {
      if (!active.current) return;
      const code = e instanceof Error ? (e.message.split(':').at(0) ?? '') : String(e);
      const unknown = !refusedBeforeDecision.has(code);
      const mismatch = code === 'attribution_mismatch';
      setNotice(mismatch ? workMessage(e) : unknown ? workMessage('decision_outcome_unknown') : workMessage(e));
      setUnknownOutcome(unknown && !mismatch);
      setStatusText('');
      setAlertText(copy.announce.problem);
      if (unknown || code === 'stale_payload') {
        setLocked(true);
        const fresh = await reread();
        if (fresh && !mismatch && isOpen(fresh)) setLocked(false);
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
    setAlertText('');
    setStatusText(copy.announce.checked);
    setNotice(fresh.status === 'pending' ? copy.result.checkedPending : '');
    if (fresh.status === 'pending') setLocked(!isOpen(fresh));
  }

  return {
    comment, setComment, sending, locked, confirm, setConfirm, notice, unknownOutcome, mine,
    resultRef, statusRef, statusText, alertText, decide, checkAgain,
  };
}
