import { describe, it, expect } from 'vitest';
import type { AuditEvent } from '../../lib/audit/audit-writer.js';

/**
 * Compile-time + runtime assertion that the five Jarvis audit actions (plus the
 * always-audited session_killed) are members of the AuditEvent union. If any
 * were removed from the union this array literal would fail to type-check.
 */
describe('jarvis audit actions', () => {
  it('are accepted by the AuditEvent action union', () => {
    const actions: AuditEvent['action'][] = [
      'jarvis_session_start',
      'jarvis_session_end',
      'jarvis_voice_turn',
      'jarvis_query',
      'jarvis_navigate',
      'jarvis_session_killed',
      'jarvis_canary_add',
      'jarvis_canary_remove',
      'jarvis_routine_save',
      'jarvis_routine_delete',
    ];
    expect(actions).toHaveLength(10);
  });

  it('a jarvis_navigate event carries the origin tag + route detail shape', () => {
    const evt: AuditEvent = {
      action: 'jarvis_navigate',
      surface: 'dashboard',
      userId: 'abc0123456789def',
      operatorLabel: 'Root token',
      result: 'ok',
      detail: { origin: 'jarvis', sessionId: 's1', route: '/agents', allowed: true },
    };
    expect(evt.detail?.origin).toBe('jarvis');
    expect(evt.surface).toBe('dashboard');
  });
});
