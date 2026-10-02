/**
 * Hardening tests for `pack validate`, from the review of ed29e3d (Work Platform step 3).
 * Each case is a way a bad pack was accepted, or a good one refused. Same contract:
 * docs/features/paperclip/pack-format.md.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePack, type PackFinding } from './validate.js';
import { runPackCli } from '../../pack.js';

const VALID = join(dirname(fileURLToPath(import.meta.url)), '../../../tests/fixtures/packs/valid');
const scratch = mkdtempSync(join(tmpdir(), 'pack-hardening-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
function pack(change: (dir: string) => void = () => {}): string {
  const dir = join(scratch, `p${n++}`);
  cpSync(VALID, dir, { recursive: true });
  change(dir);
  return dir;
}
function json(file: string, edit: (doc: any) => void): (dir: string) => void {
  return (dir) => {
    const path = join(dir, file);
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    edit(doc);
    writeFileSync(path, JSON.stringify(doc, null, 2));
  };
}
function text(file: string, from: string, to: string): (dir: string) => void {
  return (dir) => {
    const path = join(dir, file);
    const before = readFileSync(path, 'utf8');
    if (!before.includes(from)) throw new Error(`fixture drift: ${file} lacks ${from}`);
    writeFileSync(path, before.replace(from, to));
  };
}
/** Append one line to the customer doc. */
const doc = (line: string) => text('docs/customer.md', 'A fixture pack.', `A fixture pack. ${line}`);
const codes = (findings: PackFinding[]): string[] => [...new Set(findings.map((f) => f.code))].sort();

// Assembled at run time so repository scans never trip on this file.
const AWS_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE';
const ACCOUNT = ['1234', '5678', '9012'].join('');
const escaped = (s: string) => [...s].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
const routineDescription = (rawJsonString: string) => text('paperclip/routines/sla-check.json',
  '"description": "Escalates a referral', `"description": "${rawJsonString} escalates a referral`);

const BAD: Array<[name: string, code: string, change: (dir: string) => void]> = [
  // Escapes must not hide a secret or an identifier: scan the parsed strings as well as the bytes.
  ['a secret written with JSON unicode escapes', 'PV-SECRET', routineDescription(escaped(AWS_KEY))],
  ['an email written with JSON unicode escapes', 'PV-IDENTIFIER', routineDescription(escaped('bob@acme-clinic.com'))],
  ['an account id written with JSON unicode escapes', 'PV-IDENTIFIER', routineDescription(escaped(ACCOUNT))],
  ['a URL written with escaped slashes', 'PV-IDENTIFIER', routineDescription('https:\\/\\/acme-clinic.com\\/p')],
  ['a secret written with a YAML hex escape', 'PV-SECRET', text('agents/intake.yaml', 'description: Reads a new referral and fills the case fields.', `description: "\\x41${AWS_KEY.slice(1)}"`)],
  ['a secret split by a YAML line continuation', 'PV-SECRET', text('agents/intake.yaml', 'description: Reads a new referral and fills the case fields.', `description: "${AWS_KEY.slice(0, 4)}\\\n  ${AWS_KEY.slice(4)}"`)],
  // Every pack file is UTF-8 text.
  ['a file that starts with a NUL byte', 'PV-SCHEMA', (d) => writeFileSync(join(d, 'docs/notes.md'), `\0 ${AWS_KEY}`)],
  ['a UTF-16 file', 'PV-SCHEMA', (d) => writeFileSync(join(d, 'docs/notes.md'), Buffer.from(`key ${AWS_KEY}`, 'utf16le'))],
  ['a file over one megabyte', 'PV-SCHEMA', (d) => writeFileSync(join(d, 'docs/big.md'), 'a '.repeat(600_000))],
  ['a symlink inside the pack', 'PV-SCHEMA', (d) => symlinkSync(join(d, 'ui.json'), join(d, 'docs/link.json'))],
  ['the bundle path is a file', 'PV-SCHEMA', json('pack.json', (p) => { p.resources.bundle = 'paperclip/bundle/README.md'; })],
  ['a listed file path is a directory', 'PV-SCHEMA', json('pack.json', (p) => { p.resources.skills.push('docs'); })],
  // Names are looked up as own keys only.
  ['a config field named __proto__', 'PV-SCHEMA', text('config/schema.json', '"properties": {', '"properties": {\n    "__proto__": { "type": "boolean", "customerEditable": true },')],
  ['a config field name with uppercase letters', 'PV-SCHEMA', json('config/schema.json', (s) => { s.properties.EscalationHours = { type: 'number' }; })],
  ['required names an inherited property', 'PV-SCHEMA', json('config/schema.json', (s) => { s.required.push('toString'); })],
  ['a placeholder names an inherited property', 'PV-PLACEHOLDER', routineDescription('${config.constructor}')],
  ['a placeholder sits in an object key', 'PV-PLACEHOLDER', json('paperclip/routines/sla-check.json', (r) => { r.env = { '${config.nope}': 1 }; })],
  ['requires.connectors names an inherited property', 'PV-REF', json('pack.json', (p) => { p.requires.connectors.push('toString'); })],
  ['ui.json has an inherited property name as a pipeline', 'PV-REF', json('ui.json', (u) => { u.pipelines.constructor = { keyFields: [] }; })],
  // Duplicates.
  ['two agents share a role', 'PV-SCHEMA', (d) => { cpSync(join(d, 'agents/intake.yaml'), join(d, 'agents/intake2.yaml')); json('pack.json', (p) => { p.agents.push({ role: 'intake', definition: 'agents/intake2.yaml', mappable: false }); })(d); }],
  ['two decision classes share an id', 'PV-SCHEMA', json('pack.json', (p) => { p.decisionClasses.push({ ...p.decisionClasses[0] }); })],
  ['two stages share a key', 'PV-SCHEMA', json('paperclip/pipelines/referral.json', (p) => { p.stages.push({ key: 'clinical-review', name: 'Again', kind: 'review' }); })],
  ['two pipelines share a key', 'PV-SCHEMA', (d) => { cpSync(join(d, 'paperclip/pipelines/referral.json'), join(d, 'paperclip/pipelines/referral2.json')); json('pack.json', (p) => { p.resources.pipelines.push('paperclip/pipelines/referral2.json'); })(d); }],
  ['a resource path is listed twice', 'PV-SCHEMA', json('pack.json', (p) => { p.resources.skills.push('skills/intake.md'); })],
  ['two routines share a base name', 'PV-SCHEMA', (d) => { mkdirSync(join(d, 'paperclip/more')); cpSync(join(d, 'paperclip/routines/sla-check.json'), join(d, 'paperclip/more/sla-check.json')); json('pack.json', (p) => { p.resources.routines.push({ path: 'paperclip/more/sla-check.json', kind: 'timer', pipeline: 'referral' }); })(d); }],
  // Agent YAML tags.
  ['an agent file uses a verbatim tag', 'PV-SCHEMA', text('agents/intake.yaml', 'name: Intake Agent', 'name: !<tag:pack.example,2020:x> Intake Agent')],
  ['an agent file uses a %TAG handle', 'PV-SCHEMA', (d) => { const f = join(d, 'agents/intake.yaml'); writeFileSync(f, `%TAG !e! tag:pack.example,2020:\n---\n${readFileSync(f, 'utf8').replace('name: Intake Agent', 'name: !e!foo Intake Agent')}`); }],
  // Tools are allowed per role.
  ['an agent uses a tool permitted only to another role', 'PV-REF', (d) => {
    writeFileSync(join(d, 'agents/review.yaml'), 'id: review\nname: Review Agent\ndescription: Reviews.\nmodel: us.anthropic.claude-sonnet-4-6\npersona: You review.\ntools:\n  - get_time\n');
    json('pack.json', (p) => { p.agents.push({ role: 'review', definition: 'agents/review.yaml', mappable: false }); })(d);
  }],
  // Gate fields: every way a config field can reach an approval gate.
  ['a gate field named in an object key of a gated stage', 'PV-GATE', (d) => {
    json('paperclip/pipelines/referral.json', (p) => { p.stages[1].config = { '${config.site}': true }; })(d);
    json('config/schema.json', (s) => { s.properties.site.customerEditable = true; })(d);
  }],
  ['a gate field named at the pipeline level of a gated pipeline', 'PV-GATE', (d) => {
    json('paperclip/pipelines/referral.json', (p) => { p.description = 'Skips review when ${config.site} says so'; })(d);
    json('config/schema.json', (s) => { s.properties.site.customerEditable = true; })(d);
  }],
  ['a gate field reached through a routine the gated stage names', 'PV-GATE', json('paperclip/pipelines/referral.json', (p) => { p.stages[1].config.onEnter = '${routine:sla-check}'; })],
  // Identifier forms.
  ['a URL with another scheme', 'PV-IDENTIFIER', doc('Files: ftp://files.acme-clinic.com/x')],
  ['a storage URL', 'PV-IDENTIFIER', doc('Bucket s3://acme-clinic-prod/reports')],
  ['a scheme-relative URL', 'PV-IDENTIFIER', doc('See //acme-clinic.com/intake')],
  ['a bare www host', 'PV-IDENTIFIER', doc('See www.acme-clinic.com')],
  ['a reserved name hidden behind a fragment', 'PV-IDENTIFIER', doc('https://acme-clinic.com#.example.com')],
  ['a reserved name hidden behind a query', 'PV-IDENTIFIER', doc('https://acme-clinic.com?x=.test')],
  ['an email with an IP host', 'PV-IDENTIFIER', doc('Mail bob@10.1.2.3')],
  ['an email with a non-ASCII host', 'PV-IDENTIFIER', doc('Mail bob@münchen-klinik.de')],
  ['an account id with dashes', 'PV-IDENTIFIER', doc(`Account ${ACCOUNT.slice(0, 4)}-${ACCOUNT.slice(4, 8)}-${ACCOUNT.slice(8)}`)],
  ['an account id with spaces', 'PV-IDENTIFIER', doc(`Account ${ACCOUNT.slice(0, 4)} ${ACCOUNT.slice(4, 8)} ${ACCOUNT.slice(8)}`)],
  ['an email in a file name', 'PV-IDENTIFIER', (d) => writeFileSync(join(d, 'docs/bob@acme-clinic.com.md'), 'notes')],
];

describe('pack validate hardening: bad packs', () => {
  it.each(BAD)('rejects %s (%s)', (_name, code, change) => {
    expect(codes(validatePack(pack(change)))).toEqual([code]);
  });
  it('rejects a denylist word split by a zero-width space or hidden by an escape', () => {
    expect(codes(validatePack(pack(doc('For Acme​-clinic.')), { denylist: ['acme-clinic'] }))).toEqual(['PV-IDENTIFIER']);
    expect(codes(validatePack(pack(routineDescription(escaped('acme-clinic'))), { denylist: ['acme-clinic'] }))).toEqual(['PV-IDENTIFIER']);
  });
  it('rejects a denylist word in a directory name', () => {
    const dir = pack((d) => { mkdirSync(join(d, 'docs/acme-clinic')); writeFileSync(join(d, 'docs/acme-clinic/a.md'), 'notes'); });
    expect(codes(validatePack(dir, { denylist: ['acme-clinic'] }))).toEqual(['PV-IDENTIFIER']);
  });
  it('reports a secret and an identifier in the same file as two findings', () => {
    expect(codes(validatePack(pack(doc(`${AWS_KEY} bob@acme-clinic.com`))))).toEqual(['PV-IDENTIFIER', 'PV-SECRET']);
  });
  it('still scans the rest of the pack when one path is a symlink', () => {
    const dir = pack((d) => { symlinkSync(join(d, 'ui.json'), join(d, 'docs/link.json')); doc(AWS_KEY)(d); });
    expect(codes(validatePack(dir))).toEqual(['PV-SCHEMA', 'PV-SECRET']);
  });
  it('reports one finding per file and rule, however many ways the scan sees it', () => {
    const findings = validatePack(pack(json('paperclip/routines/intake.json', (r) => { r.variables[0].defaultValue = AWS_KEY; })));
    expect(findings).toHaveLength(1);
  });
});

describe('pack validate hardening: good packs stay good', () => {
  it.each([
    ['a reserved URL followed by a full stop', 'See https://example.com.'],
    ['a reserved URL in brackets', '(https://example.com)'],
    ['a reserved URL with a query', 'https://example.com?x=1'],
    ['a reserved URL with a fragment', 'https://docs.example.org/a#top'],
    ['a version number and a time', 'Tested on v2026.916.1 at 12:30:45, ratio 3//2'],
  ])('accepts %s', (_name, line) => {
    expect(validatePack(pack(doc(line)))).toEqual([]);
  });
  it('validates a 200,000 character line in under two seconds', () => {
    const dir = pack((d) => writeFileSync(join(d, 'docs/long.md'), 'a'.repeat(200_000)));
    const started = Date.now();
    expect(validatePack(dir)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('pack validate hardening: findings a pack author can act on', () => {
  it('points at the bad key of a file that fails its shape', () => {
    const [f] = validatePack(pack(json('config/schema.json', (s) => { s.properties.site.type = 'date'; })));
    expect(f).toMatchObject({ code: 'PV-SCHEMA', file: 'config/schema.json' });
    expect(f!.pointer).toContain('site');
  });
  it('names the resource path that is wrong', () => {
    const findings = validatePack(pack(json('pack.json', (p) => { p.resources.skills.push('skills/a.md', 'skills/b.md'); })));
    expect(findings.map((f) => f.message).join('\n')).toMatch(/skills\/a\.md[\s\S]*skills\/b\.md/);
  });
  it('names the unknown tool, placeholder and config field', () => {
    const tool = validatePack(pack(text('agents/intake.yaml', '  - get_time', '  - delete_everything')));
    expect(tool[0]!.message).toContain('delete_everything');
    const placeholder = validatePack(pack(text('paperclip/routines/sla-check.json', '${config.escalation_hours}', '${config.escalate_after}')));
    expect(placeholder[0]!.message).toContain('escalate_after');
    const gate = validatePack(pack(json('config/schema.json', (s) => { s.properties.clinical_review_required.customerEditable = true; })));
    expect(gate[0]!.pointer ?? gate[0]!.message).toContain('clinical_review_required');
  });
});

describe('pack CLI hardening', () => {
  const run = (argv: string[]) => { const lines: string[] = []; return { code: runPackCli(argv, (l) => lines.push(l)), lines }; };
  it('exits 2 when the denylist file has no entries', () => {
    const deny = join(scratch, 'empty.txt');
    writeFileSync(deny, '# nothing here\n\n');
    expect(run(['validate', VALID, '--denylist', deny]).code).toBe(2);
  });
  it('says so when no denylist was applied', () => {
    const r = run(['validate', VALID]);
    expect(r.code).toBe(0);
    expect(r.lines.join('\n')).toMatch(/no denylist/i);
  });
});
