import { describe, it, expect } from 'vitest';
import { ALL_KILL_SWITCHES, KILL_SWITCH_META, type KillSwitchName } from './kill-switches-repo.js';

describe('kill switches inventory', () => {
  it('exports all 40 named switches (the two signature-check bypass switches were REMOVED in Wave A: an unsigned webhook forges the sender principal)', () => {
    expect(ALL_KILL_SWITCHES.length).toBe(40);
  });

  it('includes the oauth + salesforce switches', () => {
    for (const s of ['oauth_connect_disabled', 'salesforce_disabled'] as KillSwitchName[]) {
      expect(ALL_KILL_SWITCHES).toContain(s);
      expect(KILL_SWITCH_META[s].category).toBe('Integrations');
    }
  });

  it('includes the chat media switches', () => {
    const media: KillSwitchName[] = ['chat_kb_ingest_disabled', 'video_processing_disabled'];
    for (const s of media) {
      expect(ALL_KILL_SWITCHES).toContain(s);
      expect(KILL_SWITCH_META[s].category).toBe('Integrations');
    }
  });

  it('includes the 3 Jarvis switches', () => {
    const jarvis: KillSwitchName[] = ['jarvis_disabled', 'jarvis_voice_disabled', 'jarvis_canary_mode'];
    for (const s of jarvis) {
      expect(ALL_KILL_SWITCHES).toContain(s);
      expect(KILL_SWITCH_META[s].category).toBe('Agent Behavior');
    }
  });

  it('includes the v5.7 incident switches', () => {
    const v57: KillSwitchName[] = ['sessions_frozen'];
    for (const s of v57) {
      expect(ALL_KILL_SWITCHES).toContain(s);
    }
  });

  it('NEVER reintroduces an authentication-bypass switch (Wave A prohibition)', () => {
    // The old slack/telegram signature_check_disabled switches accepted
    // UNSIGNED webhooks, letting an attacker forge the sender principal and
    // defeat the allowlist + provenance planes. Break-glass for a broken
    // secret is DISABLE INGRESS, never "accept unsigned traffic".
    for (const name of ALL_KILL_SWITCHES as readonly string[]) {
      expect(name).not.toMatch(/signature_check/);
    }
  });

  it('has META for every switch', () => {
    for (const s of ALL_KILL_SWITCHES) {
      expect(KILL_SWITCH_META[s]).toBeDefined();
      expect(KILL_SWITCH_META[s].description.length).toBeGreaterThan(0);
    }
  });

  it('includes document_gen_disabled (C1)', () => {
    expect(ALL_KILL_SWITCHES).toContain('document_gen_disabled');
  });

  it('includes the 5 v3 add-on switches', () => {
    const addonSwitches: KillSwitchName[] = [
      'image_gen_disabled',
      'tts_disabled',
      'email_send_disabled',
      'web_search_disabled',
      'pii_redaction_enabled',
    ];
    for (const s of addonSwitches) {
      expect(ALL_KILL_SWITCHES).toContain(s);
    }
  });

  it('preserves the v1 core switches', () => {
    const core: KillSwitchName[] = [
      'bedrock_global',
      'tool_use',
      'memory_writes',
      'telegram_posting',
      'slack_posting',
    ];
    for (const s of core) {
      expect(ALL_KILL_SWITCHES).toContain(s);
    }
  });

  it('includes all v5.6 switches', () => {
    const v56: KillSwitchName[] = [
      'memory_consolidation_disabled',
      'memory_context_v2_disabled',
      'exfil_guard_disabled',
      'exfil_custom_patterns_disabled',
      'warroom_disabled',
      'warroom_router_disabled',
      'warroom_intervention_disabled',
      'hooks_disabled',
      'skills_disabled',
      'extension_deployer_disabled',
      'chaos_bedrock_throttle_opus',
      'chaos_bedrock_throttle_sonnet',
      'chaos_bedrock_throttle_haiku',
      'chaos_secrets_throttle',
    ];
    for (const s of v56) {
      expect(ALL_KILL_SWITCHES).toContain(s);
    }
  });

  it('has no duplicates', () => {
    expect(new Set(ALL_KILL_SWITCHES).size).toBe(ALL_KILL_SWITCHES.length);
  });
});
