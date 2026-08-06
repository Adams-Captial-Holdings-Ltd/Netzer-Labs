/**
 * F2 · k6 load test against /api/test-turn.
 *
 * Three-stage ramp: 1 RPS → 10 RPS → 100 RPS, five minutes each.
 * Validates that:
 *   - the ALB + Fargate autoscale absorb the burst without errors
 *   - the daily cost cap kill switch (CCE_DAILY_COST_CAP_USD) trips
 *     cleanly when sustained 100 RPS exceeds the cap (expected
 *     mid-test — capped turns return non-200 but the script keeps
 *     running so we see how the system degrades)
 *   - p95 latency stays under the SLO (5s) during the unthrottled
 *     stages
 *
 * Run with:
 *   k6 run \
 *     -e PUBLIC_HOST=staging.claudeclaw-enterprise.com \
 *     -e DASHBOARD_TOKEN="$(aws secretsmanager get-secret-value \
 *        --secret-id /claudeclaw/dashboard \
 *        --query SecretString --output text \
 *        | python3 -c \"import sys,json; print(json.loads(sys.stdin.read())['token'])\")" \
 *     tests/load/test-turn.js
 *
 * NEVER point this at prod with the default RPS curve — at 100 RPS for
 * 5 min, a single run can spend $300+ in Bedrock token costs before
 * the cost cap kicks in. Use staging, or lower --vus / shorten the
 * 100-RPS stage when smoke-testing against prod.
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const PUBLIC_HOST = __ENV.PUBLIC_HOST || 'staging.claudeclaw-enterprise.com';
const TOKEN = __ENV.DASHBOARD_TOKEN || '';
const AGENT_ID = __ENV.AGENT_ID || 'main';

if (!TOKEN) {
  throw new Error('DASHBOARD_TOKEN env var is required (see header comment)');
}

const costCappedCounter = new Counter('cost_cap_responses');
const turnLatency = new Trend('turn_latency_ms', true);

export const options = {
  scenarios: {
    low: {
      executor: 'constant-arrival-rate',
      rate: 1,
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: 5,
      maxVUs: 20,
      exec: 'turn',
      tags: { stage: 'low' },
    },
    medium: {
      executor: 'constant-arrival-rate',
      rate: 10,
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: 20,
      maxVUs: 80,
      startTime: '5m30s',
      exec: 'turn',
      tags: { stage: 'medium' },
    },
    high: {
      executor: 'constant-arrival-rate',
      rate: 100,
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: 100,
      maxVUs: 400,
      startTime: '11m',
      exec: 'turn',
      tags: { stage: 'high' },
    },
  },
  thresholds: {
    // The low + medium stages must hit the SLO. The high stage allows
    // cost-cap 4xx responses, so we don't add a strict failure threshold
    // there — read the per-stage breakdown in the k6 summary instead.
    'http_req_duration{stage:low}': ['p(95)<5000'],
    'http_req_duration{stage:medium}': ['p(95)<5000'],
    'http_req_failed{stage:low}': ['rate<0.01'],
    'http_req_failed{stage:medium}': ['rate<0.02'],
  },
};

export function turn() {
  const payload = JSON.stringify({
    agentId: AGENT_ID,
    chatId: `loadtest-${__VU}-${__ITER}`,
    text: 'ping (loadtest) - reply with exactly the word "pong"',
  });
  const res = http.post(
    `https://${PUBLIC_HOST}/api/test-turn`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: '30s',
    },
  );
  turnLatency.add(res.timings.duration);

  const isCapped =
    res.status === 503 ||
    (res.status === 200 && /cost cap|daily cap exceeded/i.test(res.body || ''));
  if (isCapped) costCappedCounter.add(1);

  check(res, {
    'returned a response': (r) => r.status > 0,
    'ok or capped': (r) =>
      r.status === 200 || r.status === 503 || r.status === 429,
  });

  // Give the server a beat between iterations within a VU — k6's
  // arrival-rate scheduler handles the headline RPS, this just smooths
  // VU reuse.
  sleep(0.05);
}

export function handleSummary(data) {
  const stages = ['low', 'medium', 'high'];
  const rows = stages.map((s) => {
    const dur = data.metrics[`http_req_duration{stage:${s}}`];
    const fail = data.metrics[`http_req_failed{stage:${s}}`];
    return {
      stage: s,
      p95_ms: dur && dur.values ? Math.round(dur.values['p(95)']) : null,
      avg_ms: dur && dur.values ? Math.round(dur.values.avg) : null,
      fail_rate: fail && fail.values ? fail.values.rate : null,
    };
  });
  // eslint-disable-next-line no-console
  console.log('\n=== ClaudeClaw load test summary ===');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ stages: rows, costCapped: data.metrics.cost_cap_responses?.values?.count ?? 0 }, null, 2));
  return {
    stdout: '',
    'tests/load/last-run.json': JSON.stringify(
      { stages: rows, full: data.metrics },
      null,
      2,
    ),
  };
}
