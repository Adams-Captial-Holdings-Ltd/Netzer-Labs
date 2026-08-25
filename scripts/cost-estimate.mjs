#!/usr/bin/env node
/**
 * Netzar OS Enterprise, recalculable per-tier cost estimator.
 *
 * Plain Node, zero dependencies. Run it with:
 *
 *   node scripts/cost-estimate.mjs                       # all four tiers
 *   node scripts/cost-estimate.mjs --tier=1              # one tier
 *   node scripts/cost-estimate.mjs --json                # machine-readable
 *   node scripts/cost-estimate.mjs --private-endpoints   # as if CCE_PRIVATE_ENDPOINTS=1
 *
 * EVERYTHING tunable lives in the two constant blocks below:
 *   UNIT_PRICES, per-resource AWS unit prices (us-east-1, as of 2026-07).
 *                 These AGE. When AWS reprices, edit here and re-run; the
 *                 docs page (docs/cost-guide.md) tells readers to do exactly
 *                 that instead of trusting stale numbers.
 *   ASSUMPTIONS, the light-traffic usage profile the estimate is built on.
 *
 * TIER_SHAPES mirrors TIERS in infra/lib/constants.ts (this script cannot
 * import TypeScript). If you change a tier's shape there, update it here in
 * the same PR.
 */

// ── UNIT PRICES (USD, us-east-1, on-demand, as of 2026-07, EDIT ME) ──
const UNIT_PRICES = {
  // Fargate ARM64 (the task runtime platform is linux/arm64)
  fargateVcpuHour: 0.03238,
  fargateGbHour: 0.00356,
  // Networking
  natGatewayHour: 0.045,
  natDataPerGb: 0.045,
  albHour: 0.0225,
  albLcuHour: 0.008,
  interfaceEndpointPerAzHour: 0.01, // opt-in via CCE_PRIVATE_ENDPOINTS
  // Paperclip work engine substrate (ADR 0010), provisioned at the tiers whose
  // TierShape.paperclipEnabled is true. Aurora Serverless v2 bills by ACU-hour
  // and the FLOOR is not tiered (database-stack.ts holds serverlessV2MinCapacity
  // at 0.5 on every tier), so the floor bills 24/7.
  auroraAcuHour: 0.12,
  auroraStoragePerGbMonth: 0.1,
  efsStandardPerGbMonth: 0.3,
  // Storage / crypto / secrets
  kmsKeyMonth: 1.0,
  secretMonth: 0.4,
  s3StandardPerGbMonth: 0.023,
  ecrStoragePerGbMonth: 0.1,
  // Observability
  cwLogsIngestPerGb: 0.5,
  cwLogsStoragePerGbMonth: 0.03,
  cwAlarmMonth: 0.1,
  cwDashboardMonth: 3.0, // first 3 dashboards free; we model 1 paid
  flowLogsPerGb: 0.5, // delivered to S3, CW vended-log pricing
  xrayPerMillionTraces: 5.0,
  // Edge & security (tier-gated)
  wafWebAclMonth: 5.0,
  wafRuleMonth: 1.0,
  wafPerMillionRequests: 0.6,
  cloudFrontPerGbOut: 0.085, // free tier often covers light traffic
  guardDutyLightMonth: 10.0, // usage-based; light-account observation
  awsConfigLightMonth: 5.0, // usage-based; light-account observation
  // DNS
  route53HostedZoneMonth: 0.5,
  // DynamoDB on-demand (per million request units)
  ddbWritePerMillion: 1.25,
  ddbReadPerMillion: 0.25,
  // Bedrock (per 1M tokens), variable cost, reported separately
  bedrockSonnetInPer1M: 3.0,
  bedrockSonnetOutPer1M: 15.0,
  bedrockHaikuInPer1M: 1.0,
  bedrockHaikuOutPer1M: 5.0,
};

// ── ASSUMPTIONS (light-traffic profile, EDIT ME) ─────────────────────
const ASSUMPTIONS = {
  hoursPerMonth: 730,
  region: 'us-east-1',
  asOf: '2026-07',
  natDataGbPerMonth: 10, // egress through NAT (AWS API calls mostly ride free gateway endpoints)
  albAvgLcu: 1, // light traffic ≈ 1 LCU
  logsIngestGbPerMonth: { 0: 1, 1: 3, 2: 8, 3: 15 }, // grows with task count / retention tier
  flowLogsGbPerMonth: 1,
  s3StorageGb: 5,
  ecrStorageGb: 2,
  paperclipAuroraMinAcu: 0.5, // mirrors serverlessV2MinCapacity in database-stack.ts
  paperclipAuroraStorageGb: 10,
  paperclipEfsGb: 5,
  paperclipTaskCpu: 2048, // infra/lib/paperclip-stack.ts PaperclipTaskDef
  paperclipTaskMemMb: 4096,
  ddbWritesPerMonthMillions: 0.5,
  ddbReadsPerMonthMillions: 2,
  alarmCount: 9,
  kmsKeyCount: 3,
  secretCount: 6,
  hasDomain: true, // Route 53 hosted zone line; set false for no-domain infra-only
  privateEndpoints: false, // CCE_PRIVATE_ENDPOINTS=1 adds ~15 interface endpoints x 2 AZs
  interfaceEndpointCount: 15,
  azCount: 2,
  wafMillionRequestsPerMonth: 1,
  xrayMillionTracesPerMonth: 0.1,
  cloudFrontGbOutPerMonth: 5,
  // Bedrock variable-cost illustration (NOT part of the fixed floor):
  turnsPerDay: 50,
  inputTokensPerTurn: 6000, // system prompt + memories + history add up fast
  outputTokensPerTurn: 500,
};

// ── TIER SHAPES (mirror of infra/lib/constants.ts TIERS, keep in sync) ──
const TIER_SHAPES = {
  0: { label: 'Hobby', cpu: 512, memMb: 1024, minTasks: 1, nat: 1, waf: false, cloudFront: false, flowLogs: false, xray: false, worm: false, guardDutyConfig: false, paperclip: false, dailyCapDefault: 5 },
  1: { label: 'Standard', cpu: 1024, memMb: 2048, minTasks: 2, nat: 2, waf: false, cloudFront: false, flowLogs: true, xray: false, worm: false, guardDutyConfig: false, paperclip: true, dailyCapDefault: 50 },
  2: { label: 'Pro', cpu: 2048, memMb: 4096, minTasks: 2, nat: 2, waf: true, cloudFront: false, flowLogs: true, xray: true, worm: true, guardDutyConfig: false, paperclip: true, dailyCapDefault: 200 },
  3: { label: 'Enterprise', cpu: 2048, memMb: 4096, minTasks: 3, nat: 2, waf: true, cloudFront: true, flowLogs: true, xray: true, worm: true, guardDutyConfig: true, paperclip: true, dailyCapDefault: 1000 },
};

const round = (n) => Math.round(n * 100) / 100;

function estimateTier(tier) {
  const t = TIER_SHAPES[tier];
  const P = UNIT_PRICES;
  const A = ASSUMPTIONS;
  const H = A.hoursPerMonth;
  const lines = [];
  const add = (label, usd, note = '') => lines.push({ label, usd: round(usd), note });

  // Compute (always-on minimum task count; autoscale above this costs more)
  const vcpu = t.cpu / 1024;
  const gb = t.memMb / 1024;
  add(
    `Fargate ${t.minTasks}x (${vcpu} vCPU / ${gb} GB, ARM64)`,
    t.minTasks * (vcpu * P.fargateVcpuHour + gb * P.fargateGbHour) * H,
    'minimum task count; autoscaling above it adds linearly',
  );
  add(`NAT gateway x${t.nat}`, t.nat * P.natGatewayHour * H + A.natDataGbPerMonth * P.natDataPerGb, `${A.natDataGbPerMonth} GB/mo data assumed`);
  add('ALB', P.albHour * H + A.albAvgLcu * P.albLcuHour * H, `${A.albAvgLcu} LCU avg assumed`);
  add(`KMS CMKs x${A.kmsKeyCount}`, A.kmsKeyCount * P.kmsKeyMonth);
  add(`Secrets Manager x${A.secretCount}`, A.secretCount * P.secretMonth);
  const logsGb = A.logsIngestGbPerMonth[tier];
  add('CloudWatch logs ingest', logsGb * P.cwLogsIngestPerGb, `${logsGb} GB/mo assumed`);
  add(`CloudWatch alarms x${A.alarmCount} + dashboard`, A.alarmCount * P.cwAlarmMonth + P.cwDashboardMonth);
  add('S3 + ECR storage', A.s3StorageGb * P.s3StandardPerGbMonth + A.ecrStorageGb * P.ecrStoragePerGbMonth, `${A.s3StorageGb} GB S3 + ${A.ecrStorageGb} GB ECR`);
  add('DynamoDB on-demand', A.ddbWritesPerMonthMillions * P.ddbWritePerMillion + A.ddbReadsPerMonthMillions * P.ddbReadPerMillion, 'light traffic');
  if (A.hasDomain) add('Route 53 hosted zone', P.route53HostedZoneMonth);
  if (t.flowLogs) add('VPC Flow Logs', A.flowLogsGbPerMonth * P.flowLogsPerGb, `${A.flowLogsGbPerMonth} GB/mo assumed`);
  // Paperclip work engine (ADR 0010). Gated on the SAME per-tier field CDK
  // deploys from (TierShape.paperclipEnabled), so this line appears at exactly
  // the tiers that provision the substrate. Before it existed, fixedMonthlyUsd
  // under-reported T1+ by roughly $110 and the deploy gate patched over the gap
  // with a prose note — while cost-guardrails-stack.ts derived its tiered budget
  // default from a figure this estimator did not produce.
  // The environment-scoped provisioning override folded in, so the estimator
  // this repository's own money gate spawns cannot quote a Tier 0 floor that
  // omits an Aurora cluster the same run is about to create. Mirrors
  // `paperclipProvisioned` in infra/lib/constants.ts (this script cannot import
  // TypeScript); one-directional there and one-directional here.
  if (t.paperclip || process.env.CCE_PAPERCLIP_PROVISION_ENV_OVERRIDE === '1') {
    const pcVcpu = A.paperclipTaskCpu / 1024;
    const pcGb = A.paperclipTaskMemMb / 1024;
    add(
      'Aurora Serverless v2 floor (Paperclip)',
      A.paperclipAuroraMinAcu * P.auroraAcuHour * H +
        A.paperclipAuroraStorageGb * P.auroraStoragePerGbMonth,
      `min ${A.paperclipAuroraMinAcu} ACU bills 24/7; the ceiling is tiered, the floor is not`,
    );
    add('EFS (Paperclip state)', A.paperclipEfsGb * P.efsStandardPerGbMonth, `${A.paperclipEfsGb} GB assumed`);
    add(
      `Fargate x1 (Paperclip, ${pcVcpu} vCPU / ${pcGb} GB, ARM64)`,
      (pcVcpu * P.fargateVcpuHour + pcGb * P.fargateGbHour) * H,
      'desiredCount 1, no autoscaling',
    );
  }
  if (t.waf) add('WAFv2 (ACL + 4 rules + requests)', P.wafWebAclMonth + 4 * P.wafRuleMonth + A.wafMillionRequestsPerMonth * P.wafPerMillionRequests);
  if (t.xray) add('X-Ray', A.xrayMillionTracesPerMonth * P.xrayPerMillionTraces, 'light tracing');
  if (t.cloudFront) add('CloudFront', A.cloudFrontGbOutPerMonth * P.cloudFrontPerGbOut, 'free tier may cover this entirely');
  if (t.guardDutyConfig) add('GuardDuty + AWS Config', P.guardDutyLightMonth + P.awsConfigLightMonth, 'usage-based; light-account observation, not a quote');
  if (A.privateEndpoints) {
    add(
      `VPC interface endpoints x${A.interfaceEndpointCount} (OPT-IN)`,
      A.interfaceEndpointCount * A.azCount * P.interfaceEndpointPerAzHour * H,
      'only when CCE_PRIVATE_ENDPOINTS=1; the single biggest optional line',
    );
  }

  const fixed = round(lines.reduce((s, l) => s + l.usd, 0));

  // Variable Bedrock illustration (NOT included in the fixed floor)
  const inTok = (A.turnsPerDay * 30.4 * A.inputTokensPerTurn) / 1e6;
  const outTok = (A.turnsPerDay * 30.4 * A.outputTokensPerTurn) / 1e6;
  const bedrockSonnet = round(inTok * P.bedrockSonnetInPer1M + outTok * P.bedrockSonnetOutPer1M);
  const bedrockHaiku = round(inTok * P.bedrockHaikuInPer1M + outTok * P.bedrockHaikuOutPer1M);

  return { tier, label: t.label, lines, fixedMonthlyUsd: fixed, dailyCapDefault: t.dailyCapDefault, bedrock: { turnsPerDay: A.turnsPerDay, sonnetUsdPerMonth: bedrockSonnet, haikuUsdPerMonth: bedrockHaiku } };
}

// ── CLI ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const json = args.includes('--json');
// The deploy confirmation gate spawns this script with the flag when the
// operator's .env sets CCE_PRIVATE_ENDPOINTS=1, so the printed floor matches
// what that deploy will actually create.
if (args.includes('--private-endpoints')) ASSUMPTIONS.privateEndpoints = true;
const tierArg = args.find((a) => a.startsWith('--tier='));
const tiers = tierArg ? [Number(tierArg.split('=')[1])] : [0, 1, 2, 3];

const results = tiers.map(estimateTier);

if (json) {
  console.log(JSON.stringify({ asOf: ASSUMPTIONS.asOf, region: ASSUMPTIONS.region, assumptions: ASSUMPTIONS, results }, null, 2));
} else {
  console.log(`Netzar OS Enterprise cost estimate, region ${ASSUMPTIONS.region}, unit prices as of ${ASSUMPTIONS.asOf}`);
  console.log('Unit prices age. Edit the UNIT_PRICES block at the top of this file and re-run.\n');
  for (const r of results) {
    console.log(`T${r.tier} ${r.label}, estimated fixed floor: ~$${r.fixedMonthlyUsd}/mo`);
    for (const l of r.lines) {
      console.log(`   ${l.label.padEnd(46)} $${String(l.usd).padStart(8)}${l.note ? `   (${l.note})` : ''}`);
    }
    console.log(
      `   Variable (illustration, ${r.bedrock.turnsPerDay} turns/day): Sonnet ~$${r.bedrock.sonnetUsdPerMonth}/mo, Haiku ~$${r.bedrock.haikuUsdPerMonth}/mo` +
        `, capped by the daily cost cap (tier default $${r.dailyCapDefault}/day)\n`,
    );
  }
  console.log('Excluded: data transfer beyond the stated assumptions, Polly/Transcribe/SES usage,');
  console.log('generated images (~$0.04/image on the Stability default), autoscaling above the minimum task count, and taxes.');
}
