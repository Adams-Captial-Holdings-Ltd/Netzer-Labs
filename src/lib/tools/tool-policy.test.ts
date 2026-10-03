/**
 * FROZEN acceptance tests for Work Platform step 5 (B4: tool policy enforced in
 * Netzer). Pure decision table. Do not edit without the owner's yes.
 *
 * `allow` is the role's tool allowlist from the pack's canonical agent format
 * (absent = no allowlist). `aiStep` marks an AI (L2) step: it may read, analyze
 * and draft, never write. `readOnly` is the built-in handler's own mark;
 * `remote` is a tool served by a customer-connected server.
 */
import { describe, it, expect } from 'vitest';
import { toolDecision } from './tool-policy.js';

const allowed = { allowed: true };
const denied = (reason: string) => ({ allowed: false, reason });

describe('toolDecision', () => {
  it('an ordinary chat turn with no role allowlist keeps every tool', () => {
    expect(toolDecision('send_dm', { readOnly: false, remote: false })).toEqual(allowed);
    expect(toolDecision('mcp__crm__update', { readOnly: false, remote: true })).toEqual(allowed);
  });

  it('a role allowlist admits only the tools it names, built-in or remote, in any turn', () => {
    const allow = ['get_time', 'mcp__crm__lookup'];
    expect(toolDecision('get_time', { allow, readOnly: true, remote: false })).toEqual(allowed);
    expect(toolDecision('mcp__crm__lookup', { allow, readOnly: false, remote: true })).toEqual(allowed);
    expect(toolDecision('send_dm', { allow, readOnly: false, remote: false })).toEqual(denied('not_in_role_allowlist'));
    expect(toolDecision('mcp__crm__update', { allow, readOnly: false, remote: true })).toEqual(denied('not_in_role_allowlist'));
  });

  it('an EMPTY allowlist means no tools, never all tools', () => {
    expect(toolDecision('get_time', { allow: [], readOnly: true, remote: false })).toEqual(denied('not_in_role_allowlist'));
  });

  it('an AI step keeps a built-in tool only when the handler is marked read-only (default deny)', () => {
    expect(toolDecision('list_missions', { aiStep: true, readOnly: true, remote: false })).toEqual(allowed);
    expect(toolDecision('paperclip_add_comment', { aiStep: true, readOnly: false, remote: false })).toEqual(denied('write_denied_in_ai_step'));
    expect(toolDecision('paperclip_create_subtask', { aiStep: true, readOnly: false, remote: false })).toEqual(denied('write_denied_in_ai_step'));
  });

  it('a role allowlist cannot grant an AI step a built-in write tool', () => {
    expect(toolDecision('send_email', { aiStep: true, allow: ['send_email'], readOnly: false, remote: false }))
      .toEqual(denied('write_denied_in_ai_step'));
  });

  it('an AI step gets a remote tool only when the role allowlist names it', () => {
    expect(toolDecision('mcp__crm__lookup', { aiStep: true, readOnly: false, remote: true })).toEqual(denied('write_denied_in_ai_step'));
    expect(toolDecision('mcp__crm__lookup', { aiStep: true, allow: ['mcp__crm__lookup'], readOnly: false, remote: true })).toEqual(allowed);
    expect(toolDecision('mcp__crm__update', { aiStep: true, allow: ['mcp__crm__lookup'], readOnly: false, remote: true }))
      .toEqual(denied('not_in_role_allowlist'));
  });

  it('matching is exact: no prefix, case or whitespace tricks', () => {
    const allow = ['get_time'];
    for (const name of ['get_time ', 'GET_TIME', 'get_time_evil', 'get', '']) {
      expect(toolDecision(name, { allow, readOnly: true, remote: false })).toEqual(denied('not_in_role_allowlist'));
    }
  });
});
