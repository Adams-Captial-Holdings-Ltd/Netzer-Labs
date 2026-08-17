'use strict';
/**
 * CCE power-switch Lambda (Phase B). Pause/wake CCE prod from outside the system
 * it controls. Two entry shapes:
 *
 *   - HTTP (Function URL): POST /pause | /wake | /status | /hold, gated by the
 *     X-Power-Token header (compared in constant time to a Secrets Manager value).
 *   - Direct invoke (EventBridge Scheduler): { source:'cce.power.scheduler',
 *     action:'auto-pause' }. Authorised purely by IAM — only the scheduler role is
 *     granted lambda:InvokeFunction on this function — and the handler rejects any
 *     direct event that does not match the exact contract.
 *
 * Safety machinery (mirrors the hardened plan):
 *   - A DynamoDB lease lock (acquire on attribute_not_exists OR expiresAt<now,
 *     opId-fenced, released in finally) serialises pause/wake; reserved
 *     concurrency 1 backs it up.
 *   - An intent-first marker (`pausing`/`waking` written BEFORE mutations) so a
 *     crash can never read as awake; `paused-partial` on failure.
 *   - Kill-switch writes also publish the config-invalidation message (awaited),
 *     so peer tasks tear down live Bedrock streams immediately, not after 30s.
 *   - Alarm muting records each alarm's prior ActionsEnabled and restores only
 *     those that were enabled.
 */
const crypto = require('crypto');
const fs = require('fs');
const {
  ECSClient,
  UpdateServiceCommand,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
} = require('@aws-sdk/client-ecs');
const { EC2Client, DescribeNatGatewaysCommand } = require('@aws-sdk/client-ec2');
const {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
} = require('@aws-sdk/client-elastic-load-balancing-v2');
const { KMSClient, ListAliasesCommand } = require('@aws-sdk/client-kms');
const { WAFV2Client, ListWebACLsCommand } = require('@aws-sdk/client-wafv2');
const { Route53Client, ListHostedZonesCommand } = require('@aws-sdk/client-route-53');
const { CostExplorerClient, GetCostAndUsageCommand } = require('@aws-sdk/client-cost-explorer');
const {
  ApplicationAutoScalingClient,
  RegisterScalableTargetCommand,
  DescribeScalableTargetsCommand,
} = require('@aws-sdk/client-application-auto-scaling');
const {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  DeleteItemCommand,
} = require('@aws-sdk/client-dynamodb');
const { EventBridgeClient, DisableRuleCommand, EnableRuleCommand, DescribeRuleCommand } = require('@aws-sdk/client-eventbridge');
const {
  CloudWatchClient,
  DisableAlarmActionsCommand,
  EnableAlarmActionsCommand,
  DescribeAlarmsCommand,
} = require('@aws-sdk/client-cloudwatch');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const {
  SecretsManagerClient,
  GetSecretValueCommand,
  ListSecretsCommand,
} = require('@aws-sdk/client-secrets-manager');

const E = process.env;
const REGION = E.AWS_REGION || 'us-east-1';
const CLUSTER = E.CLUSTER;
const SERVICE = E.SERVICE;
const RES_ID = E.RES_ID; // service/<cluster>/<service>
const DIM = 'ecs:service:DesiredCount';
const SWITCH_TABLE = E.SWITCH_TABLE;
const POWER_TABLE = E.POWER_TABLE;
const TOPIC_ARN = E.TOPIC_ARN || '';
const CONSOLIDATION_RULE = E.CONSOLIDATION_RULE || '';
const TOKEN_SECRET_ARN = E.TOKEN_SECRET_ARN;
const WAKE_MIN = parseInt(E.WAKE_MIN || '3', 10);
const WAKE_MAX = parseInt(E.WAKE_MAX || '20', 10);
const WAKE_DESIRED = parseInt(E.WAKE_DESIRED || '3', 10);
const HOLD_MS = parseInt(E.HOLD_HOURS || '6', 10) * 3600 * 1000;
const LEASE_MS = parseInt(E.LEASE_MINUTES || '15', 10) * 60 * 1000;
const MUTED_ALARMS = (E.MUTED_ALARMS || '').split(',').map((s) => s.trim()).filter(Boolean);
const HEALTH_URL = E.HEALTH_URL || '';
const DASHBOARD_URL = E.DASHBOARD_URL || '';
const COST_NOTE = E.COST_NOTE || '';
const AUTO_PAUSE_LABEL = E.AUTO_PAUSE_LABEL || '';
// Exact literal '1', matching the convention used by every other feature flag:
// a stray 'true' or 'false' must not be able to authorise taking the connectors down.
const AUTO_PAUSE_FORBIDDEN = E.AUTO_PAUSE_FORBIDDEN === '1';
const APP_TAG_VALUE = E.APP_TAG_VALUE || 'claudeclaw-enterprise';
const APP_PREFIX = E.APP_PREFIX || 'claudeclaw';
const STACK_PREFIX = E.STACK_PREFIX || 'CCE';
const ACTIONS = new Set(['pause', 'wake', 'status', 'hold', 'costs', 'auto-pause']);

const ecs = new ECSClient({ region: REGION });
const ec2 = new EC2Client({ region: REGION });
const elb = new ElasticLoadBalancingV2Client({ region: REGION });
const kms = new KMSClient({ region: REGION });
const waf = new WAFV2Client({ region: 'us-east-1' }); // CLOUDFRONT scope lives in us-east-1
const r53 = new Route53Client({ region: REGION });
const ce = new CostExplorerClient({ region: 'us-east-1' });
const aas = new ApplicationAutoScalingClient({ region: REGION });
const ddb = new DynamoDBClient({ region: REGION });
const eb = new EventBridgeClient({ region: REGION });
const cw = new CloudWatchClient({ region: REGION });
const sns = new SNSClient({ region: REGION });
const sm = new SecretsManagerClient({ region: REGION });

const log = (o) => console.log(JSON.stringify(o));
const resp = (code, body) => ({
  statusCode: code,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// The always-on control page, read once at cold start from the bundled asset.
let PANEL_HTML = '<!doctype html><title>power</title><h1>panel unavailable</h1>';
try {
  PANEL_HTML = fs.readFileSync(__dirname + '/panel.html', 'utf8');
} catch (e) {
  console.error('panel.html read failed: ' + String(e && e.message));
}
const htmlResp = (html) => ({
  statusCode: 200,
  headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  body: html,
});

// ── token auth (Function URL) ───────────────────────────────────────
let _token = null;
async function loadToken() {
  if (_token) return _token;
  const out = await sm.send(new GetSecretValueCommand({ SecretId: TOKEN_SECRET_ARN }));
  let raw = out.SecretString || '';
  try {
    const j = JSON.parse(raw);
    raw = j.token || raw;
  } catch (_e) {
    /* plain string secret */
  }
  _token = raw;
  return _token;
}
function timingEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length || ab.length === 0) return false;
  return crypto.timingSafeEqual(ab, bb);
}
async function validToken(event) {
  const h = event.headers || {};
  const provided = h['x-power-token'] || h['X-Power-Token'] || '';
  if (!provided) return false;
  return timingEqual(provided, await loadToken());
}

// ── DynamoDB marker + lease lock ────────────────────────────────────
async function getState() {
  const out = await ddb.send(new GetItemCommand({ TableName: POWER_TABLE, Key: { PK: { S: 'STATE' } } }));
  const it = out.Item;
  if (!it) return { mode: 'unknown' };
  return {
    mode: it.mode ? it.mode.S : 'unknown',
    opId: it.opId ? it.opId.S : undefined,
    since: it.since ? it.since.S : undefined,
    by: it.by ? it.by.S : undefined,
    keepAwakeUntil: it.keepAwakeUntil ? parseInt(it.keepAwakeUntil.N, 10) : 0,
    mutedAlarms: it.mutedAlarms ? it.mutedAlarms.L.map((x) => x.S) : [],
  };
}
async function putState(s) {
  const item = {
    PK: { S: 'STATE' },
    mode: { S: s.mode },
    since: { S: s.since || new Date().toISOString() },
    by: { S: s.by || 'power-switch' },
    keepAwakeUntil: { N: String(s.keepAwakeUntil || 0) },
  };
  if (s.opId) item.opId = { S: s.opId };
  if (s.mutedAlarms && s.mutedAlarms.length) item.mutedAlarms = { L: s.mutedAlarms.map((a) => ({ S: a })) };
  await ddb.send(new PutItemCommand({ TableName: POWER_TABLE, Item: item }));
}
async function acquireLock(opId, by) {
  const now = Date.now();
  try {
    await ddb.send(
      new PutItemCommand({
        TableName: POWER_TABLE,
        Item: { PK: { S: 'LOCK' }, opId: { S: opId }, by: { S: by }, expiresAt: { N: String(now + LEASE_MS) } },
        ConditionExpression: 'attribute_not_exists(PK) OR expiresAt < :now',
        ExpressionAttributeValues: { ':now': { N: String(now) } },
      }),
    );
    return true;
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}
async function releaseLock(opId) {
  try {
    await ddb.send(
      new DeleteItemCommand({
        TableName: POWER_TABLE,
        Key: { PK: { S: 'LOCK' } },
        ConditionExpression: 'opId = :o',
        ExpressionAttributeValues: { ':o': { S: opId } },
      }),
    );
  } catch (err) {
    if (err.name !== 'ConditionalCheckFailedException') throw err;
    // someone else owns the lock now (our lease expired); leave it.
  }
}

// ── kill switches (DDB write + awaited invalidation publish) ────────
async function setSwitch(name, active, reason, opId) {
  await ddb.send(
    new PutItemCommand({
      TableName: SWITCH_TABLE,
      Item: {
        PK: { S: 'SWITCH#' + name },
        SK: { S: 'STATUS' },
        active: { BOOL: active },
        setBy: { S: 'power-switch' },
        setAt: { S: new Date().toISOString() },
        reason: { S: reason },
      },
    }),
  );
  // Awaited so peers tear down live Bedrock/Jarvis streams before we return, not
  // after the 30s cache poll. But truly best-effort: a transient SNS failure or a
  // missing topic must NOT abort the pause (the DDB write above is the source of
  // truth; peers still fall back to the 30s cache). We log it and move on.
  if (TOPIC_ARN) {
    try {
      await sns.send(
        new PublishCommand({
          TopicArn: TOPIC_ARN,
          Message: JSON.stringify({ kind: 'kill_switch', key: name, origin: 'power-switch-' + opId }),
        }),
      );
    } catch (err) {
      log({ msg: 'invalidation publish failed; peers fall back to 30s cache', switch: name, err: String(err && err.message) });
    }
  }
}
async function getSwitch(name) {
  const out = await ddb.send(
    new GetItemCommand({ TableName: SWITCH_TABLE, Key: { PK: { S: 'SWITCH#' + name }, SK: { S: 'STATUS' } } }),
  );
  return Boolean(out.Item && out.Item.active && out.Item.active.BOOL);
}

// ── alarms (capture prior state, restore only previously-enabled) ───
// MUTED_ALARMS entries are PREFIXES, not exact names: CDK generates alarm names
// like CCE-Observability-SchedulerStalledAlarmAF06EAAA-yAaegX7OFjiQ, so an exact
// allowlist would go stale on every stack regeneration. Each entry resolves via
// AlarmNamePrefix; only alarms whose actions were enabled are muted, and only
// those exact resolved names are recorded for restore.
async function muteAlarms() {
  const muted = [];
  for (const prefix of MUTED_ALARMS) {
    try {
      const d = await cw.send(new DescribeAlarmsCommand({ AlarmNamePrefix: prefix }));
      const all = [...(d.MetricAlarms || []), ...(d.CompositeAlarms || [])];
      for (const a of all) {
        if (a && a.AlarmName && a.ActionsEnabled) {
          await cw.send(new DisableAlarmActionsCommand({ AlarmNames: [a.AlarmName] }));
          muted.push(a.AlarmName);
        }
      }
    } catch (err) {
      log({ msg: 'alarm mute failed', alarmPrefix: prefix, err: String(err && err.message) });
    }
  }
  return muted;
}
async function restoreAlarms(muted) {
  for (const name of muted || []) {
    try {
      await cw.send(new EnableAlarmActionsCommand({ AlarmNames: [name] }));
    } catch (err) {
      log({ msg: 'alarm restore failed', alarm: name, err: String(err && err.message) });
    }
  }
}

// ── ECS / autoscaling primitives ────────────────────────────────────
async function setBounds(min, max) {
  await aas.send(
    new RegisterScalableTargetCommand({
      ServiceNamespace: 'ecs',
      ResourceId: RES_ID,
      ScalableDimension: DIM,
      MinCapacity: min,
      MaxCapacity: max,
    }),
  );
}
async function setDesired(n) {
  await ecs.send(new UpdateServiceCommand({ cluster: CLUSTER, service: SERVICE, desiredCount: n }));
}
async function ruleState(name) {
  if (!name) return 'unknown';
  try {
    const d = await eb.send(new DescribeRuleCommand({ Name: name }));
    return d.State || 'unknown';
  } catch (_e) {
    return 'not-found';
  }
}
async function toggleRule(name, enable) {
  if (!name) return;
  try {
    await eb.send(enable ? new EnableRuleCommand({ Name: name }) : new DisableRuleCommand({ Name: name }));
  } catch (err) {
    log({ msg: 'rule toggle failed', rule: name, enable, err: String(err && err.message) });
  }
}

// ── pause / wake / status / hold / auto-pause ───────────────────────
async function doPause(by) {
  const opId = crypto.randomUUID();
  if (!(await acquireLock(opId, by))) return { ok: false, code: 409, error: 'busy (another power op holds the lock)' };
  let muted = [];
  try {
    await putState({ mode: 'pausing', opId, by, since: new Date().toISOString() });
    // switches first so live streams tear down before we drain.
    await setSwitch('bedrock_global', true, 'demo pause (' + by + ')', opId);
    await setSwitch('memory_consolidation_disabled', true, 'demo pause (' + by + ')', opId);
    await toggleRule(CONSOLIDATION_RULE, false);
    muted = await muteAlarms();
    await setBounds(0, 0);
    await setDesired(0);
    await putState({ mode: 'paused', opId, by, since: new Date().toISOString(), mutedAlarms: muted });
    log({ msg: 'paused', by, opId, mutedAlarms: muted });
    return { ok: true, mode: 'paused', mutedAlarms: muted };
  } catch (err) {
    // Carry the muted list into the partial marker: if muting succeeded but a
    // later step failed, a future wake must still know which alarms to restore.
    await putState({ mode: 'paused-partial', opId, by, since: new Date().toISOString(), mutedAlarms: muted }).catch(() => {});
    log({ msg: 'pause failed', by, opId, err: String(err && err.message) });
    return { ok: false, code: 500, error: 'pause failed: ' + String(err && err.message) };
  } finally {
    await releaseLock(opId);
  }
}
async function doWake(by) {
  const opId = crypto.randomUUID();
  if (!(await acquireLock(opId, by))) return { ok: false, code: 409, error: 'busy (another power op holds the lock)' };
  const prev = await getState();
  try {
    await putState({ mode: 'waking', opId, by, since: new Date().toISOString(), mutedAlarms: prev.mutedAlarms });
    await setBounds(WAKE_MIN, WAKE_MAX);
    await setDesired(WAKE_DESIRED);
    await toggleRule(CONSOLIDATION_RULE, true);
    await restoreAlarms(prev.mutedAlarms);
    await setSwitch('bedrock_global', false, 'demo wake (' + by + ')', opId);
    await setSwitch('memory_consolidation_disabled', false, 'demo wake (' + by + ')', opId);
    await putState({ mode: 'awake', opId, by, since: new Date().toISOString(), keepAwakeUntil: Date.now() + HOLD_MS });
    log({ msg: 'awake', by, opId, keepAwakeUntilMs: Date.now() + HOLD_MS });
    return { ok: true, mode: 'awake', note: 'tasks rolling; poll status until running===desired' };
  } catch (err) {
    // Carry mutedAlarms forward so a retry still knows which alarms to re-enable;
    // dropping them would leave service-down alarms muted after a failed wake.
    await putState({
      mode: 'awake-partial',
      opId,
      by,
      since: new Date().toISOString(),
      mutedAlarms: prev.mutedAlarms,
    }).catch(() => {});
    log({ msg: 'wake failed', by, opId, err: String(err && err.message) });
    return { ok: false, code: 500, error: 'wake failed: ' + String(err && err.message) };
  } finally {
    await releaseLock(opId);
  }
}
async function doHold(by, hours) {
  const until = Date.now() + (hours && hours > 0 ? hours : 6) * 3600 * 1000;
  const s = await getState();
  await putState({ ...s, keepAwakeUntil: until, by });
  return { ok: true, keepAwakeUntil: until };
}
async function doAutoPause() {
  // Refuse before reading any state, so a stale or missing power-state record is
  // never what keeps the environment online. The schedule that invokes this is
  // itself DISABLED in IaC; this is what survives an out-of-band re-enable.
  if (AUTO_PAUSE_FORBIDDEN) {
    log({ msg: 'auto-pause refused', reason: 'AUTO_PAUSE_FORBIDDEN is set for this environment' });
    return { ok: true, mode: 'refused', note: 'auto-pause is forbidden in this environment' };
  }
  const s = await getState();
  if (s.mode === 'paused' || s.mode === 'pausing') return { ok: true, mode: s.mode, note: 'already paused' };
  if (s.keepAwakeUntil && Date.now() < s.keepAwakeUntil) {
    log({ msg: 'auto-pause held', keepAwakeUntil: s.keepAwakeUntil });
    return { ok: true, mode: 'held', note: 'within keep-awake window' };
  }
  return doPause('scheduler');
}
// End-to-end app probe: does the dashboard actually answer through the front
// door? This is what turns "marker says awake" into "everything is restored".
// No IAM needed — HEALTH_URL is the public /health route. Skipped (null) when
// the deploy did not configure a URL.
async function probeHealth() {
  if (!HEALTH_URL) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 3500);
  try {
    const r = await fetch(HEALTH_URL, { signal: ctl.signal, redirect: 'manual' });
    return { ok: r.status === 200, status: r.status };
  } catch (err) {
    return { ok: false, status: 0, err: String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}

// One truthful word for the panel. The marker alone lies during the 2-3 min
// wake roll (it flips to `awake` before any task is running), so the phase is
// computed from marker + live counts + the end-to-end health probe.
function computePhase(marker, desired, running, health) {
  if (marker === 'pausing' || marker === 'waking') return marker;
  if (marker === 'paused-partial' || marker === 'awake-partial') return 'partial';
  if (marker === 'paused') {
    return (desired || 0) > 0 ? 'drifted' : 'paused';
  }
  if (marker === 'awake') {
    if ((desired || 0) === 0) return 'drifted';
    if ((running || 0) < desired) return 'waking';
    if (health && !health.ok) return 'waking';
    return 'restored';
  }
  // No marker yet (fresh install): trust live counts.
  return (desired || 0) === 0 ? 'paused' : (running || 0) >= desired ? 'restored' : 'waking';
}

async function doStatus() {
  const [svc, st, bg, mcd, marker, health] = await Promise.all([
    ecs.send(new DescribeServicesCommand({ cluster: CLUSTER, services: [SERVICE] })),
    aas.send(new DescribeScalableTargetsCommand({ ServiceNamespace: 'ecs', ResourceIds: [RES_ID], ScalableDimension: DIM })),
    getSwitch('bedrock_global'),
    getSwitch('memory_consolidation_disabled'),
    getState(),
    probeHealth(),
  ]);
  const s = (svc.services || [])[0] || {};
  const t = (st.ScalableTargets || [])[0] || {};
  return {
    ok: true,
    marker: marker.mode,
    phase: computePhase(marker.mode, s.desiredCount, s.runningCount, health),
    desired: s.desiredCount,
    running: s.runningCount,
    bounds: { min: t.MinCapacity, max: t.MaxCapacity },
    bedrock_global: bg,
    memory_consolidation_disabled: mcd,
    consolidationRule: await ruleState(CONSOLIDATION_RULE),
    keepAwakeUntil: marker.keepAwakeUntil || 0,
    mutedAlarms: marker.mutedAlarms || [],
    health,
    since: marker.since || null,
    by: marker.by || null,
    wakeTarget: WAKE_DESIRED,
    dashboardUrl: DASHBOARD_URL || null,
    costNote: COST_NOTE || null,
    autoPause: AUTO_PAUSE_LABEL || null,
  };
}

// ── live maintenance costs (price book × live inventory) ────────────
// "What am I paying while paused, and what would awake cost?" Counts the
// ACTUAL always-on resources (tenant-scoped by the Application tag / name
// prefixes, so a co-located workload in the same account is never counted)
// and prices them with a small us-east-1 price book. The awake side adds
// Fargate from the LIVE task definition (size × arch × wake target) and the
// real last-30-days AI spend from Cost Explorer. Rows that cannot be metered
// per-resource (log ingestion, storage pennies, LCU traffic) are flat
// estimates and labeled as such.
const HOURS_PER_MONTH = 730;
const PRICES = {
  // us-east-1 on-demand rates, checked 2026-07. Update alongside cost-guide.
  natHourly: 0.045,
  albHourly: 0.0225,
  albLcuEstimate: 3.0,
  publicIpv4Hourly: 0.005,
  kmsKeyMonthly: 1.0,
  secretMonthly: 0.4,
  wafAclMonthlyWithRules: 9.0, // $5 ACL + managed rule groups
  hostedZoneMonthly: 0.5,
  cloudwatchEstimate: 12.0,
  storageMiscEstimate: 4.0, // DynamoDB/S3 storage, backups, Lambda, Scheduler
  fargate: {
    x86: { vcpuHourly: 0.04048, gbHourly: 0.004445 },
    arm: { vcpuHourly: 0.03238, gbHourly: 0.00356 },
  },
};

let _costsCache = null;
const COSTS_TTL_MS = 60 * 60 * 1000;

function money(n) {
  return Math.round(n * 100) / 100;
}

async function countNats() {
  const d = await ec2.send(new DescribeNatGatewaysCommand({
    Filter: [
      { Name: 'tag:Application', Values: [APP_TAG_VALUE] },
      { Name: 'state', Values: ['available'] },
    ],
  }));
  return (d.NatGateways || []).length;
}
async function countAlbs() {
  const d = await elb.send(new DescribeLoadBalancersCommand({}));
  return (d.LoadBalancers || []).filter((lb) => (lb.LoadBalancerName || '').startsWith(APP_PREFIX)).length;
}
async function countKmsKeys() {
  const d = await kms.send(new ListAliasesCommand({ Limit: 100 }));
  return (d.Aliases || []).filter((a) => (a.AliasName || '').startsWith('alias/' + APP_PREFIX)).length;
}
async function countSecrets() {
  const d = await sm.send(new ListSecretsCommand({
    MaxResults: 100,
    Filters: [{ Key: 'name', Values: [APP_PREFIX] }],
  }));
  return (d.SecretList || []).length;
}
async function countWafAcls() {
  const scopes = ['REGIONAL', 'CLOUDFRONT'];
  let n = 0;
  for (const Scope of scopes) {
    const d = await waf.send(new ListWebACLsCommand({ Scope, Limit: 100 }));
    n += (d.WebACLs || []).filter((a) => {
      const name = a.Name || '';
      return name.startsWith(STACK_PREFIX) || name.startsWith(APP_PREFIX) || name.indexOf(APP_PREFIX) >= 0;
    }).length;
  }
  return n;
}
async function countHostedZones() {
  if (!DASHBOARD_URL) return 0;
  const apex = DASHBOARD_URL.replace(/^https?:\/\//, '').split('/')[0].split('.').slice(-2).join('.');
  const d = await r53.send(new ListHostedZonesCommand({ MaxItems: 100 }));
  return (d.HostedZones || []).filter((z) => (z.Name || '').replace(/\.$/, '').endsWith(apex)).length;
}
async function fargateAwakeMonthly() {
  const svc = await ecs.send(new DescribeServicesCommand({ cluster: CLUSTER, services: [SERVICE] }));
  const tdArn = ((svc.services || [])[0] || {}).taskDefinition;
  if (!tdArn) return null;
  const td = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: tdArn }));
  const def = td.taskDefinition || {};
  const vcpu = parseInt(def.cpu || '0', 10) / 1024;
  const gb = parseInt(def.memory || '0', 10) / 1024;
  const arch = ((def.runtimePlatform || {}).cpuArchitecture || 'X86_64') === 'ARM64' ? 'arm' : 'x86';
  const rate = PRICES.fargate[arch];
  const perTask = vcpu * rate.vcpuHourly + gb * rate.gbHourly;
  return {
    tasks: WAKE_DESIRED,
    vcpu,
    gb,
    arch,
    monthlyUsd: money(perTask * HOURS_PER_MONTH * WAKE_DESIRED),
  };
}
async function aiSpendLast30d() {
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const d = await ce.send(new GetCostAndUsageCommand({
    TimePeriod: { Start: start, End: end },
    Granularity: 'MONTHLY',
    Metrics: ['UnblendedCost'],
    GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
  }));
  let total = 0;
  for (const rt of d.ResultsByTime || []) {
    for (const g of rt.Groups || []) {
      const name = (g.Keys || [''])[0];
      if (/bedrock|claude|titan|nova/i.test(name)) {
        total += parseFloat(((g.Metrics || {}).UnblendedCost || {}).Amount || '0');
      }
    }
  }
  return money(total);
}

async function doCosts() {
  if (_costsCache && Date.now() - _costsCache.at < COSTS_TTL_MS) return _costsCache.data;
  const settle = (p) => p.then((v) => v).catch((err) => {
    log({ msg: 'cost inventory item failed', err: String(err && err.message) });
    return null;
  });
  const [nats, albs, kmsKeys, secrets, wafAcls, zones, fargate, ai30d] = await Promise.all([
    settle(countNats()),
    settle(countAlbs()),
    settle(countKmsKeys()),
    settle(countSecrets()),
    settle(countWafAcls()),
    settle(countHostedZones()),
    settle(fargateAwakeMonthly()),
    settle(aiSpendLast30d()),
  ]);
  const items = [];
  const add = (name, why, monthlyUsd, live) => {
    if (monthlyUsd == null) return;
    items.push({ name, why, monthlyUsd: money(monthlyUsd), live });
  };
  if (nats != null && nats > 0)
    add(`NAT gateways × ${nats}`, 'private-subnet egress; needed the moment tasks wake', nats * PRICES.natHourly * HOURS_PER_MONTH, true);
  if (albs != null && albs > 0) {
    add(`Load balancer × ${albs}`, 'the front door; keeps your URL and TLS alive', albs * PRICES.albHourly * HOURS_PER_MONTH, true);
    add('Load balancer traffic (LCU)', 'estimate; near zero while paused', PRICES.albLcuEstimate, false);
  }
  const ipv4 = (nats || 0) + (albs || 0) * 2;
  if (ipv4 > 0)
    add(`Public IPv4 addresses × ~${ipv4}`, 'NAT + load-balancer addresses', ipv4 * PRICES.publicIpv4Hourly * HOURS_PER_MONTH, false);
  if (wafAcls != null && wafAcls > 0)
    add(`WAF web ACLs × ${wafAcls}`, 'edge + regional protection stays armed', wafAcls * PRICES.wafAclMonthlyWithRules, true);
  if (kmsKeys != null && kmsKeys > 0)
    add(`KMS keys × ${kmsKeys}`, 'encryption keys guarding your data at rest', kmsKeys * PRICES.kmsKeyMonthly, true);
  if (secrets != null && secrets > 0)
    add(`Secrets × ${secrets}`, 'stored credentials (bot tokens, API keys)', secrets * PRICES.secretMonthly, true);
  if (zones != null && zones > 0)
    add(`Route 53 zones × ${zones}`, 'your domain keeps resolving', zones * PRICES.hostedZoneMonthly, true);
  add('CloudWatch', 'logs, alarms, dashboards retention', PRICES.cloudwatchEstimate, false);
  add('Storage and control plane', 'DynamoDB + S3 data at rest, backups, this panel', PRICES.storageMiscEstimate, false);
  const floor = money(items.reduce((s, i) => s + i.monthlyUsd, 0));
  const fargateMonthly = fargate ? fargate.monthlyUsd : null;
  const awakeTotal =
    fargateMonthly != null && ai30d != null ? money(floor + fargateMonthly + ai30d) : null;
  const data = {
    ok: true,
    computedAt: new Date().toISOString(),
    rateBook: 'us-east-1 on-demand, checked 2026-07; pre-tax',
    paused: { monthlyUsd: floor, items },
    awake: {
      fargate,
      aiLast30dUsd: ai30d,
      monthlyUsd: awakeTotal,
    },
    savingsMonthlyUsd: awakeTotal != null ? money(awakeTotal - floor) : null,
  };
  _costsCache = { at: Date.now(), data };
  return data;
}

async function route(action, by, event) {
  switch (action) {
    case 'pause': return doPause(by);
    case 'wake': return doWake(by);
    case 'status': return doStatus();
    case 'hold': return doHold(by, event && event.hours);
    case 'costs': return doCosts();
    case 'auto-pause': return doAutoPause();
    default: return { ok: false, code: 400, error: 'unknown action: ' + action };
  }
}

exports.handler = async (event) => {
  const isHttp = !!(event && event.requestContext && event.requestContext.http);
  if (isHttp) {
    const method = event.requestContext.http.method;
    // Control panel: a GET returns the bookmarkable HTML page. Viewing needs no
    // token (the page has no secrets); its buttons still POST with the token.
    // This isolated-origin page stays reachable even when the ECS-served
    // dashboard is paused, which is the whole point of the external control plane.
    if (method === 'GET' || method === 'HEAD') return htmlResp(PANEL_HTML);
    if (method !== 'POST') return resp(405, { error: 'POST only' });
    if (!(await validToken(event))) return resp(401, { error: 'unauthorized' });
    const path = (event.requestContext.http.path || '/status').replace(/^\/+/, '') || 'status';
    if (!ACTIONS.has(path) || path === 'auto-pause') return resp(404, { error: 'unknown route: /' + path });
    const r = await route(path, 'http', event);
    return resp(r.ok ? 200 : r.code || 500, r);
  }
  // Direct invoke (EventBridge Scheduler). IAM-gated to the scheduler role, and
  // the ONLY scheduled contract is auto-pause. Reject any other direct action
  // (e.g. a forged wake/pause) so a stray same-account InvokeFunction can never
  // skip the Function URL token to control prod.
  if (!event || event.source !== 'cce.power.scheduler' || event.action !== 'auto-pause') {
    return { ok: false, code: 400, error: 'bad direct event' };
  }
  return route('auto-pause', 'scheduler', event);
};
