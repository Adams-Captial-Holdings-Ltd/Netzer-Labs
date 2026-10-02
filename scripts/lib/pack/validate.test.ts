/**
 * Frozen acceptance tests for `pack validate` (Work Platform step 3, gate s3-proof).
 * The contract is docs/features/paperclip/pack-format.md. Every known-bad pack is the
 * valid fixture plus ONE change, and must be rejected with exactly its own code.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePack, type PackFinding } from './validate.js';

const VALID = join(dirname(fileURLToPath(import.meta.url)), '../../../tests/fixtures/packs/valid');
const scratch = mkdtempSync(join(tmpdir(), 'pack-validate-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
/** A fresh copy of the valid pack with one change applied. */
function pack(change: (dir: string) => void = () => {}): string {
  const dir = join(scratch, `p${n++}`);
  cpSync(VALID, dir, { recursive: true });
  change(dir);
  return dir;
}
/** Edit one JSON file of the pack in place. */
function json(file: string, edit: (doc: any) => void): (dir: string) => void {
  return (dir) => {
    const path = join(dir, file);
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    edit(doc);
    writeFileSync(path, JSON.stringify(doc, null, 2));
  };
}
/** Replace text in one file of the pack. */
function text(file: string, from: string, to: string): (dir: string) => void {
  return (dir) => {
    const path = join(dir, file);
    const before = readFileSync(path, 'utf8');
    if (!before.includes(from)) throw new Error(`fixture drift: ${file} lacks ${from}`);
    writeFileSync(path, before.replace(from, to));
  };
}
const codes = (findings: PackFinding[]): string[] => [...new Set(findings.map((f) => f.code))].sort();

// Secret-shaped literals are assembled at run time so repository scans never trip on this file.
const AWS_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE';
const SLACK_TOKEN = 'xoxb-' + '1234567890-1234567890-' + 'abcdefghijklmnopqrstuvwx';
const PEM = '-----BEGIN ' + 'RSA PRIVATE KEY-----';
const ACCOUNT = ['1234', '5678', '9012'].join('');

describe('pack validate: the valid pack', () => {
  it('S3-C01 reports nothing for the valid fixture pack', () => {
    expect(validatePack(VALID)).toEqual([]);
  });
  it('S3-C01 reports nothing when the optional Studio layout is absent', () => {
    const dir = pack((d) => {
      unlinkSync(join(d, 'studio/layout.json'));
      json('pack.json', (p) => delete p.resources.studioLayout)(d);
    });
    expect(validatePack(dir)).toEqual([]);
  });
  it('S3-C10 accepts any JSON object as the Studio layout', () => {
    const dir = pack(json('studio/layout.json', (l) => { l.anything = { deep: [1, { two: true }] }; }));
    expect(validatePack(dir)).toEqual([]);
  });
  it('S3-C08 lets a field that controls no gate be customer-editable', () => {
    const dir = pack(json('config/schema.json', (s) => { s.properties.site.customerEditable = true; }));
    expect(validatePack(dir)).toEqual([]);
  });
  it('S3-C13 gives every finding a code, a pack-relative file and a message', () => {
    const findings = validatePack(pack(json('pack.json', (p) => { p.version = 'one'; })));
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.code).toMatch(/^PV-[A-Z]+$/);
      expect(f.file).toBe('pack.json');
      expect(f.message.length).toBeGreaterThan(0);
    }
  });
});

const KNOWN_BAD: Array<[id: string, name: string, code: string, change: (dir: string) => void]> = [
  // PV-SCHEMA
  ['S3-C02', 'pack.json is missing', 'PV-SCHEMA', (d) => unlinkSync(join(d, 'pack.json'))],
  ['S3-C02', 'pack.json is not JSON', 'PV-SCHEMA', (d) => writeFileSync(join(d, 'pack.json'), '{ not json')],
  ['S3-C02', 'pack.json has an unknown key', 'PV-SCHEMA', json('pack.json', (p) => { p.extra = true; })],
  ['S3-C02', 'packFormat is not 1', 'PV-SCHEMA', json('pack.json', (p) => { p.packFormat = 2; })],
  ['S3-C02', 'version is not semver', 'PV-SCHEMA', json('pack.json', (p) => { p.version = '1.0'; })],
  ['S3-C02', 'id has uppercase letters', 'PV-SCHEMA', json('pack.json', (p) => { p.id = 'Example_Referrals'; })],
  ['S3-C02', 'a routine kind is unknown', 'PV-SCHEMA', json('pack.json', (p) => { p.resources.routines[1].kind = 'cron'; })],
  ['S3-C02', 'a listed resource file does not exist', 'PV-SCHEMA', json('pack.json', (p) => { p.resources.skills.push('skills/missing.md'); })],
  ['S3-C02', 'a resource path leaves the pack', 'PV-SCHEMA', json('pack.json', (p) => { p.resources.ui = '../ui.json'; })],
  ['S3-C02', 'a resource path is absolute', 'PV-SCHEMA', json('pack.json', (p) => { p.resources.ui = '/etc/passwd'; })],
  ['S3-C02', 'a pack agent has no tools list', 'PV-SCHEMA', text('agents/intake.yaml', 'tools:\n  - ehr.client.search\n  - get_time\n', '')],
  ['S3-C02', 'an agent file has an unknown key', 'PV-SCHEMA', text('agents/intake.yaml', 'knowledgeScope: default', 'knowledgeScope: default\ntemperature: 1')],
  ['S3-C02', 'an agent file has no persona', 'PV-SCHEMA', text('agents/intake.yaml', 'persona: |', 'notes: |')],
  ['S3-C02', 'an agent file uses a YAML anchor and alias', 'PV-SCHEMA', text('agents/intake.yaml', 'name: Intake Agent\ndescription: Reads a new referral and fills the case fields.', 'name: &n Intake Agent\ndescription: *n')],
  ['S3-C02', 'an agent file holds two YAML documents', 'PV-SCHEMA', (d) => writeFileSync(join(d, 'agents/intake.yaml'), readFileSync(join(d, 'agents/intake.yaml'), 'utf8') + '---\nid: second\n')],
  ['S3-C02', 'a config field has an unknown type', 'PV-SCHEMA', json('config/schema.json', (s) => { s.properties.site.type = 'date'; })],
  ['S3-C02', 'a config default does not match its type', 'PV-SCHEMA', json('config/schema.json', (s) => { s.properties.escalation_hours.default = 'soon'; })],
  ['S3-C02', 'an enum default is not one of its values', 'PV-SCHEMA', json('config/schema.json', (s) => { s.properties.site.default = 'east'; })],
  ['S3-C02', 'a secretRef field carries a default', 'PV-SCHEMA', json('config/schema.json', (s) => { s.properties.ehr_api_key.default = 'changeme'; })],
  ['S3-C02', 'required names a field that does not exist', 'PV-SCHEMA', json('config/schema.json', (s) => { s.required.push('nope'); })],
  ['S3-C02', 'a tool risk level is unknown', 'PV-SCHEMA', json('policies.json', (p) => { p.toolRisk['ehr.client.search'] = 'severe'; })],
  ['S3-C02', 'connectors.json has an unknown key', 'PV-SCHEMA', json('connectors.json', (c) => { c.capabilities['ehr.client'].target = 'gateway-1'; })],
  ['S3-C02', 'the Studio layout is not an object', 'PV-SCHEMA', (d) => writeFileSync(join(d, 'studio/layout.json'), '[1, 2]')],
  ['S3-C02', 'a routine body has no title', 'PV-SCHEMA', json('paperclip/routines/sla-check.json', (r) => { delete r.title; })],
  ['S3-C02', 'a pipeline stage has no key', 'PV-SCHEMA', json('paperclip/pipelines/referral.json', (p) => { delete p.stages[2].key; })],
  // PV-REF
  ['S3-C03', 'an agent file id differs from its role', 'PV-REF', text('agents/intake.yaml', 'id: intake', 'id: triage')],
  ['S3-C03', 'an agent names a skill the pack does not list', 'PV-REF', text('agents/intake.yaml', '  - skills/intake.md', '  - skills/other.md')],
  ['S3-C03', 'an agent uses a tool that is neither an alias nor a permitted tool', 'PV-REF', text('agents/intake.yaml', '  - get_time', '  - delete_everything')],
  ['S3-C03', 'requires.connectors names an undeclared capability', 'PV-REF', json('pack.json', (p) => { p.requires.connectors.push('billing.claims'); })],
  ['S3-C03', 'requires.permissions.tools names an unknown role', 'PV-REF', json('pack.json', (p) => { p.requires.permissions.tools.reviewer = ['get_time']; })],
  ['S3-C03', 'a secretRef names an undeclared secret', 'PV-REF', json('config/schema.json', (s) => { s.properties.ehr_api_key.secret = 'OTHER_KEY'; })],
  ['S3-C03', 'a connectorRef names an undeclared capability', 'PV-REF', json('config/schema.json', (s) => { s.properties.ehr.capability = 'ehr.other'; })],
  ['S3-C03', 'an approval gate names an unknown pipeline', 'PV-REF', json('policies.json', (p) => { p.approvalGates[0].pipeline = 'billing'; })],
  ['S3-C03', 'an approval gate names an unknown stage', 'PV-REF', json('policies.json', (p) => { p.approvalGates[0].stage = 'legal-review'; })],
  ['S3-C03', 'a tool risk entry names an unknown tool', 'PV-REF', json('policies.json', (p) => { p.toolRisk['ehr.client.delete'] = 'high'; })],
  ['S3-C03', 'ui.json names an unknown pipeline', 'PV-REF', json('ui.json', (u) => { u.pipelines.billing = { keyFields: [] }; })],
  ['S3-C03', 'a routine names an unknown pipeline', 'PV-REF', json('pack.json', (p) => { p.resources.routines[1].pipeline = 'billing'; })],
  ['S3-C03', 'a transition names an unknown stage', 'PV-REF', json('paperclip/pipelines/referral.json', (p) => { p.transitions[1].toStageKey = 'closed'; })],
  // PV-PLACEHOLDER
  ['S3-C04', 'a routine uses an unknown config field', 'PV-PLACEHOLDER', text('paperclip/routines/sla-check.json', '${config.escalation_hours}', '${config.escalate_after}')],
  ['S3-C04', 'a pipeline uses an unknown agent role', 'PV-PLACEHOLDER', text('paperclip/pipelines/referral.json', '${agent:intake}', '${agent:triage}')],
  ['S3-C04', 'a pipeline uses an unknown routine', 'PV-PLACEHOLDER', text('paperclip/pipelines/referral.json', '${routine:sla-check}', '${routine:nightly}')],
  ['S3-C04', 'a placeholder has an unknown shape', 'PV-PLACEHOLDER', text('paperclip/routines/sla-check.json', '${config.escalation_hours}', '${env.HOURS}')],
  // PV-SECRET
  ['S3-C05', 'an AWS access key id in a routine body', 'PV-SECRET', json('paperclip/routines/intake.json', (r) => { r.variables[0].defaultValue = AWS_KEY; })],
  ['S3-C05', 'a Slack token in a skill file', 'PV-SECRET', text('skills/intake.md', '# Intake', `# Intake ${SLACK_TOKEN}`)],
  ['S3-C05', 'a private key header in the Studio layout', 'PV-SECRET', json('studio/layout.json', (l) => { l.note = PEM; })],
  ['S3-C05', 'an AWS access key id in the bundle', 'PV-SECRET', (d) => writeFileSync(join(d, 'paperclip/bundle/company.json'), JSON.stringify({ key: AWS_KEY }))],
  // PV-ENQUEUE
  ['S3-C06', 'an ingest routine coalesces', 'PV-ENQUEUE', json('paperclip/routines/intake.json', (r) => { r.concurrencyPolicy = 'coalesce_if_active'; })],
  ['S3-C06', 'an ingest routine sets no concurrency policy', 'PV-ENQUEUE', json('paperclip/routines/intake.json', (r) => { delete r.concurrencyPolicy; })],
  ['S3-C06', 'a pipeline has no ingest routine', 'PV-ENQUEUE', json('pack.json', (p) => { p.resources.routines[0].kind = 'timer'; })],
  // PV-IDENTIFIER
  ['S3-C07', 'an AWS account id in a routine', 'PV-IDENTIFIER', text('paperclip/routines/sla-check.json', 'Escalates a referral', `Account ${ACCOUNT}: escalates a referral`)],
  ['S3-C07', 'an ARN with an account id in the docs', 'PV-IDENTIFIER', text('docs/customer.md', 'A fixture pack.', `A fixture pack for arn:aws:iam::${ACCOUNT}:role/reader.`)],
  ['S3-C07', 'a real email address in a skill', 'PV-IDENTIFIER', text('skills/intake.md', 'support@example.com', 'jane.doe@acme-health.com')],
  ['S3-C07', 'a real URL in a skill', 'PV-IDENTIFIER', text('skills/intake.md', 'https://docs.example.com/intake', 'https://portal.acme-health.com/intake')],
  ['S3-C07', 'a real URL in the Studio layout', 'PV-IDENTIFIER', json('studio/layout.json', (l) => { l.link = 'https://acme-health.com'; })],
  // PV-GATE
  ['S3-C08', 'a field used inside an approval-gated stage is customer-editable', 'PV-GATE', json('config/schema.json', (s) => { s.properties.clinical_review_required.customerEditable = true; })],
  ['S3-C08', 'a field marked controlsApproval is customer-editable', 'PV-GATE', json('config/schema.json', (s) => { Object.assign(s.properties.site, { controlsApproval: true, customerEditable: true }); })],
  ['S3-C08', 'a secretRef field is customer-editable', 'PV-GATE', json('config/schema.json', (s) => { s.properties.ehr_api_key.customerEditable = true; })],
  ['S3-C08', 'a connectorRef field is customer-editable', 'PV-GATE', json('config/schema.json', (s) => { s.properties.ehr.customerEditable = true; })],
  // PV-DECISION
  ['S3-C09', 'a high-impact class allows automated decisions', 'PV-DECISION', json('pack.json', (p) => { p.decisionClasses[0].default = 'automated_allowed'; })],
  ['S3-C09', 'an approval gate uses an undeclared decision class', 'PV-DECISION', json('policies.json', (p) => { p.approvalGates[0].decisionClass = 'financial'; })],
  ['S3-C09', 'a declared decision class is never used', 'PV-DECISION', json('pack.json', (p) => { p.decisionClasses.push({ id: 'financial', impact: 'standard', default: 'human_required' }); })],
];

describe('pack validate: known-bad packs', () => {
  it.each(KNOWN_BAD)('%s rejects a pack where %s (%s)', (_id, _name, code, change) => {
    expect(codes(validatePack(pack(change)))).toEqual([code]);
  });
});

describe('pack validate: scan details', () => {
  it('S3-C05 never prints the secret it found', () => {
    const findings = validatePack(pack(json('paperclip/routines/intake.json', (r) => { r.variables[0].defaultValue = AWS_KEY; })));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.file).toBe('paperclip/routines/intake.json');
    expect(JSON.stringify(findings)).not.toContain(AWS_KEY);
  });
  it('S3-C07 never prints the identifier it found', () => {
    const findings = validatePack(pack(text('skills/intake.md', 'support@example.com', 'jane.doe@acme-health.com')));
    expect(JSON.stringify(findings)).not.toContain('jane.doe@acme-health.com');
  });
  it('S3-C07 allows the reserved example names', () => {
    const dir = pack(text('skills/intake.md', 'https://docs.example.com/intake',
      'https://docs.example.org/a http://localhost:3000/b https://pack.test/c https://x.invalid/d ops@example.net'));
    expect(validatePack(dir)).toEqual([]);
  });
  it('S3-C14 rejects a denylist entry, in any letter case', () => {
    const dir = pack(text('docs/customer.md', 'A fixture pack.', 'A fixture pack for Acme Health.'));
    expect(validatePack(dir)).toEqual([]);
    expect(codes(validatePack(dir, { denylist: ['acme health'] }))).toEqual(['PV-IDENTIFIER']);
  });
  it('S3-C14 a denylist that matches nothing changes nothing', () => {
    expect(validatePack(VALID, { denylist: ['zzz-no-such-customer'] })).toEqual([]);
  });
  it('S3-C13 reports every problem of a pack with two unrelated problems', () => {
    const dir = pack((d) => {
      json('paperclip/routines/intake.json', (r) => { r.concurrencyPolicy = 'skip_if_active'; })(d);
      json('config/schema.json', (s) => { s.properties.ehr.customerEditable = true; })(d);
    });
    expect(codes(validatePack(dir))).toEqual(['PV-ENQUEUE', 'PV-GATE']);
  });
  it('S3-C13 reports a directory that does not exist as PV-SCHEMA', () => {
    expect(codes(validatePack(join(scratch, 'no-such-pack')))).toEqual(['PV-SCHEMA']);
  });
});
