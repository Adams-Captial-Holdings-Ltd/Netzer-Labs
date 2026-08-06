/**
 * Jarvis Phase 1 pre-blocker #1 — confirm the Nova 2 Sonic model id is accepted
 * for the bidirectional stream, in the verified regions, with the task creds.
 *
 * WHY THIS EXISTS: the installed @aws-sdk/client-bedrock-runtime type for
 * InvokeModelWithBidirectionalStreamRequest.modelId still documents
 * "Currently, only amazon.nova-sonic-v1:0 is supported" — the stale
 * API-reference caveat JARVIS-PLAN.md §1c flagged. The Nova 2 model card lists
 * amazon.nova-2-sonic-v1:0 (Active, GA 2025-12-02) as supporting the
 * bidirectional stream. modelId is just a string, so the SDK will not reject
 * it — only a live control-plane / runtime call confirms the endpoint accepts
 * it. This script does the read-only control-plane check (GetFoundationModel)
 * across the four In-Region homes. It makes NO billed runtime call.
 *
 * Usage (needs AWS creds — run it yourself, e.g. `! tsx scripts/jarvis-nova-preflight.ts`):
 *   tsx scripts/jarvis-nova-preflight.ts                 # all 4 verified regions
 *   tsx scripts/jarvis-nova-preflight.ts --region=us-east-1
 *   tsx scripts/jarvis-nova-preflight.ts --model=amazon.nova-2-sonic-v1:0
 *
 * Exit code is non-zero if the target Nova 2 Sonic model is not ACTIVE in any
 * checked region, so it can gate a CI/staging step.
 */

import {
  BedrockClient,
  GetFoundationModelCommand,
  type FoundationModelDetails,
} from '@aws-sdk/client-bedrock';
import { bold, dim, green, red, yellow, section, ok } from './lib/ansi.js';

// In-Region only, no Geo/Global profile (verified, JARVIS-PLAN.md §1c).
const VERIFIED_REGIONS = ['us-east-1', 'us-west-2', 'eu-north-1', 'ap-northeast-1'];
const TARGET_MODEL = 'amazon.nova-2-sonic-v1:0';
const LEGACY_MODEL = 'amazon.nova-sonic-v1:0'; // EOL 2026-09-14 — checked for contrast only

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const arg of args) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq > 0) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    else flags[arg.slice(2)] = 'true';
  }
  return flags;
}

interface ModelResult {
  region: string;
  modelId: string;
  status: 'ACTIVE' | 'LEGACY' | 'NOT_FOUND' | 'ACCESS_DENIED' | 'ERROR';
  detail: string;
}

async function checkModel(region: string, modelId: string): Promise<ModelResult> {
  const client = new BedrockClient({ region });
  try {
    const out = await client.send(new GetFoundationModelCommand({ modelIdentifier: modelId }));
    const d: FoundationModelDetails | undefined = out.modelDetails;
    const lifecycle = d?.modelLifecycle?.status ?? 'UNKNOWN';
    const input = (d?.inputModalities ?? []).join('+') || '—';
    const output = (d?.outputModalities ?? []).join('+') || '—';
    const streaming = d?.responseStreamingSupported ? 'streaming' : 'no-stream';
    return {
      region,
      modelId,
      status: lifecycle === 'ACTIVE' ? 'ACTIVE' : 'LEGACY',
      detail: `${lifecycle} · in:${input} out:${output} · ${streaming}`,
    };
  } catch (err) {
    const name = (err as { name?: string }).name ?? '';
    if (name === 'ResourceNotFoundException') {
      return { region, modelId, status: 'NOT_FOUND', detail: 'not offered in this region' };
    }
    if (name === 'AccessDeniedException') {
      return { region, modelId, status: 'ACCESS_DENIED', detail: 'caller lacks bedrock:GetFoundationModel here' };
    }
    return { region, modelId, status: 'ERROR', detail: err instanceof Error ? err.message : String(err) };
  }
}

function render(r: ModelResult): string {
  const tag =
    r.status === 'ACTIVE' ? green('ACTIVE')
    : r.status === 'LEGACY' ? yellow('LEGACY')
    : r.status === 'NOT_FOUND' ? dim('NOT_FOUND')
    : red(r.status);
  return `  ${bold(r.region.padEnd(15))} ${r.modelId.padEnd(26)} ${tag}  ${dim(r.detail)}`;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const regions = flags.region ? [flags.region] : VERIFIED_REGIONS;
  const models = flags.model ? [flags.model] : [TARGET_MODEL, LEGACY_MODEL];

  section('Jarvis Nova 2 Sonic preflight (control-plane, read-only)');
  console.log(dim('Confirms the accepted model id per region. The SDK type docstring still says only v1 — ignore it; trust this live check (§1c).'));
  console.log('');

  const results: ModelResult[] = [];
  for (const region of regions) {
    for (const model of models) {
      const r = await checkModel(region, model);
      results.push(r);
      console.log(render(r));
    }
  }

  console.log('');
  const targetActive = results.filter((r) => r.modelId === TARGET_MODEL && r.status === 'ACTIVE');
  if (targetActive.length > 0) {
    console.log(ok(`${TARGET_MODEL} is ACTIVE in: ${targetActive.map((r) => r.region).join(', ')}`));
    console.log(dim('Next: a live bidirectional stream-open (during nova-sonic.ts wiring) confirms the Nova 2 event field casing end-to-end.'));
    process.exit(0);
  } else {
    console.log(red(`${TARGET_MODEL} is NOT ACTIVE in any checked region (${regions.join(', ')}).`));
    console.log(yellow('Do not cut a Phase 1 tag until this resolves — check region availability and the bedrock:GetFoundationModel grant.'));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
