#!/usr/bin/env node
// Q68 review-layer policy for Netzer-Labs steps (references/review-gauntlet.md section 10). Node built-ins only; no network.
//   review-plan.mjs plan --tier T3|T2|T1|docs
//   review-plan.mjs verify --tier T --log FILE
//   review-plan.mjs send-check --layer kodus|coderabbit|greptile --step ID --sha SHA [--slug S]
// Exit codes: 0 ok, 1 verify failed, 2 usage (verify: INCOMPLETE, a required layer NOT RUN), 4 send-check refused.
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const TIERS = {
  T3: { required: ['L0', 'critic', 'step-maid', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6'], forbidden: [], optional: ['L7'] },
  T2: { required: ['L0', 'critic', 'step-maid'], forbidden: ['L1', 'L2', 'L3', 'L6'], optional: [] },
  T1: { required: ['L0'], forbidden: ['L1', 'L2', 'L3', 'L6'], optional: [] },
  docs: { required: ['L0'], forbidden: ['L1', 'L2', 'L3', 'L6'], optional: [] },
};
const NAME = { L1: 'kodus', L2: 'coderabbit', L3: 'nvidia', L6: 'greptile' };
const SENDS = { kodus: "Kodus'", coderabbit: "CodeRabbit's", greptile: "Greptile's" };
const SHA = /^[0-9a-f]{40}$/;
const LINE = /^REVIEW: (L0|critic|step-maid|L[1-7]) (ran|NOT RUN \(.+\)|skipped \(.+\)) ([0-9a-f]{40})(?: ledger=(\S+))?$/;

class Usage extends Error {}
const arg = (argv, n) => {
  const i = argv.indexOf(n);
  if (i < 0) return undefined;
  if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Usage(`${n} needs a value`);
  return argv[i + 1];
};
const need = (argv, n) => arg(argv, n) ?? (() => { throw new Usage(`${n} is required`); })();
const tierOf = (argv) => {
  const t = need(argv, '--tier');
  if (!Object.hasOwn(TIERS, t)) throw new Usage(`unknown tier ${t} (T3|T2|T1|docs)`);
  return t;
};

async function verify(argv, out) {
  const tier = tierOf(argv);
  const file = need(argv, '--log');
  if (!existsSync(file)) throw new Usage(`log ${file} not found`);
  const spec = TIERS[tier];
  const problems = [];
  const incomplete = [];
  const seen = new Map(); // layer -> [{status, sha}]
  let n = 0;
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    n += 1;
    if (!line.startsWith('REVIEW:')) continue;
    const m = LINE.exec(line);
    if (!m) { problems.push(`UNPARSEABLE: line ${n}`); continue; }
    const status = m[2].startsWith('NOT RUN') ? 'notrun' : m[2].startsWith('skipped') ? (m[1] === 'L2' && m[2] === 'skipped (not substantial)' ? 'skipped' : 'badskip') : 'ran';
    seen.set(m[1], [...(seen.get(m[1]) ?? []), { status, sha: m[3] }]);
  }
  const ran = (l) => (seen.get(l) ?? []).filter((e) => e.status === 'ran');
  for (const l of spec.forbidden) if (ran(l).length) problems.push(`FORBIDDEN LAYER RAN: ${l} ${NAME[l]}`);
  let l3NotRun = false;
  for (const l of spec.required) {
    const es = seen.get(l) ?? [];
    if (es.some((e) => e.status === 'ran')) continue;
    if (l === 'L2' && es.some((e) => e.status === 'skipped')) continue; // not substantial
    if (es.some((e) => e.status === 'badskip')) { problems.push(`UNSUPPORTED SKIP: ${l} (only L2 "skipped (not substantial)" is allowed)`); continue; }
    if (es.some((e) => e.status === 'notrun')) { if (l === 'L3') l3NotRun = true; else incomplete.push(l); continue; }
    problems.push(`MISSING LAYER: ${l}`);
  }
  if (tier === 'T3') {
    const g = ran('L6');
    if (g.length > 1) problems.push(`GREPTILE PASSES: ${g.length} (T3 allows 1)`);
    const finalSha = ran('L0').at(-1)?.sha;
    if (g.length && g.some((e) => e.sha !== finalSha)) problems.push('GREPTILE SHA != FINAL SHA');
  }
  for (const p of problems) out.log(p);
  if (problems.length) return 1;
  for (const l of incomplete) out.log(`INCOMPLETE: ${l} NOT RUN`);
  if (incomplete.length) return 2;
  out.log(`TIER OK ${tier}${l3NotRun ? ' (L3 NOT RUN: allowed exception)' : ''}`);
  return 0;
}

// A yes record is single-use: the nth matching record is claimed by exclusively creating "<file>.used.<n>", so two
// racing send-checks can never both consume it and a crash cannot leave a lock behind.
function sendCheck(argv, env, out) {
  const layer = need(argv, '--layer');
  if (!Object.hasOwn(SENDS, layer)) throw new Usage(`unknown layer ${layer} (kodus|coderabbit|greptile)`);
  const step = need(argv, '--step');
  const sha = need(argv, '--sha');
  if (!SHA.test(sha)) throw new Usage('--sha must be the full lowercase commit id (40 hex characters)');
  const file = env.GAUNTLET_SENDS ?? join(homedir(), '.claude', 'plans', `${arg(argv, '--slug') ?? 'netzar'}-reviews`, 'sends.jsonl');
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  let matched = false;
  for (const [i, l] of lines.entries()) {
    let r;
    try { r = JSON.parse(l); } catch { continue; }
    if (!r || r.layer !== layer || r.step !== step || r.sha !== sha || !/\byes\b/i.test(r.owner_text ?? '')) continue;
    matched = true;
    try { mkdirSync(dirname(file), { recursive: true }); closeSync(openSync(`${file}.used.${i}`, 'wx', 0o600)); } catch (e) {
      if (e.code === 'EEXIST') continue;
      throw e;
    }
    out.log('SEND OK');
    return 0;
  }
  out.log(matched ? 'yes already used' : `ASK OWNER: ${layer} would send Netzer-Labs@${sha.slice(0, 12)} (diff vs origin/development) to ${SENDS[layer]} service. Reply yes for this run only.`);
  return 4;
}

async function main(argv, env = process.env, out = console) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'plan') {
      const tier = tierOf(rest);
      const { required, forbidden, optional } = TIERS[tier];
      out.log(JSON.stringify({ tier, required, forbidden, ...(optional.length ? { optional } : {}) }));
      return 0;
    }
    if (cmd === 'verify') return await verify(rest, out);
    if (cmd === 'send-check') return sendCheck(rest, env, out);
    throw new Usage('usage: review-plan.mjs plan --tier T | verify --tier T --log FILE | send-check --layer L --step ID --sha SHA [--slug S]');
  } catch (e) {
    if (!(e instanceof Usage)) throw e;
    out.error(e.message);
    return 2;
  }
}

process.exit(await main(process.argv.slice(2)));
