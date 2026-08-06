/**
 * Cost analyst — a READ-ONLY Bedrock cost-optimization explainer.
 *
 * Given the live AWS spend picture the Cost tab already shows (month-to-date,
 * month-end projection, by-service breakdown, the daily-cap budget, and the
 * waste scan), it asks the model to answer the four questions an operator
 * actually has when the projected number looks high:
 *
 *   1. In plain English, what is driving the bill?
 *   2. For each thing I am paying for: what does it do, and do I need it?
 *   3. What concrete optimizations can I make, ranked by payoff?
 *   4. Give me a plan I can paste into Claude Code to do it via the AWS CLI.
 *
 * It mirrors the compliance analyst (src/lib/compliance/analyst.ts): same
 * Bedrock client, same strict-JSON contract, same fail-loud behaviour so the
 * router can surface a clean 502. It never mutates anything — the dollar
 * figures are the authoritative ones we read from Cost Explorer, NOT numbers
 * the model invents; we only ask the model for the prose and the plan and
 * re-attach the real amounts ourselves.
 */

import { converseTurn } from '../bedrock/client.js';
import { logger } from '../../observability/logger.js';
import type { CostSummary, CostRisksResult, CostServiceSlice } from './cost-reader.js';

const MODEL =
  process.env.BEDROCK_COST_MODEL ??
  process.env.BEDROCK_SONNET_MODEL ??
  process.env.BEDROCK_DEFAULT_MODEL ??
  'us.anthropic.claude-sonnet-4-6';

/** How necessary a line item looks, from the model's read of the bill. */
export type CostNecessity = 'essential' | 'review' | 'likely-waste';

/** One service the account is paying for, explained in plain English. */
export interface CostDriver {
  /** AWS service name, verbatim from the Cost Explorer breakdown. */
  service: string;
  /** Authoritative month-to-date spend for this service (from CE, not the model). */
  monthToDateUsd: number;
  /** Share of the month-to-date bill, 0-100 (computed, not from the model). */
  sharePct: number;
  /** Plain-English description of what this AWS service does. */
  whatItIs: string;
  /** Whether the account plausibly needs it, from the spend pattern + waste scan. */
  necessity: CostNecessity;
  /** 1-3 sentences: why it costs what it does and whether it can be trimmed. */
  assessment: string;
  /**
   * A credible cheaper service/config to switch to, with roughly how much it
   * would save (e.g. "gp2 → gp3 EBS, ~20% less"). Empty when no good swap
   * exists. This is the "what could I sub instead" answer per service.
   */
  cheaperAlternative: string;
}

/**
 * A non-obvious, recurring drain — the "skeleton in the closet" a non-expert
 * would not notice: data egress, NAT data processing, aged snapshots,
 * over-retentive logs, idle/forgotten resources, over-provisioning, etc. This
 * is the value a FinOps consultant adds beyond the mechanical waste scan.
 */
export interface HiddenCost {
  title: string;
  /** What it is, why it quietly adds up, and why it is easy to miss. */
  detail: string;
  /** Approximate monthly drain in USD; 0 when it cannot be quantified. */
  estMonthlyUsd: number;
}

/** One concrete, ranked cost optimization. */
export interface CostOptimization {
  title: string;
  /** Plain-English why: what is wasteful and what changes. */
  rationale: string;
  /**
   * The cheaper service/config to switch TO, if this is a substitution
   * (e.g. "NAT Gateway → interface VPC endpoints", "on-demand → a Compute
   * Savings Plan"). Empty for non-substitution fixes like deleting waste.
   */
  alternative: string;
  /** Estimated monthly saving in USD; 0 when it cannot be quantified. */
  estMonthlySavingsUsd: number;
  /** Approximate monthly cost of this line AFTER the change; 0 when unknown. */
  estNewMonthlyUsd: number;
  effort: 'low' | 'medium' | 'high';
  priority: 'high' | 'medium' | 'low';
}

export interface CostReport {
  generatedAt: string;
  modelId: string;
  /** What the report itself cost to generate (this is the Cost tab, after all). */
  generationCostUsd: number;
  /** False when Cost Explorer data was unavailable; then the prose fields are empty. */
  available: boolean;
  note?: string;
  /** 2-4 sentence plain-English read of the bill and the projection vs budget. */
  headline: string;
  verdict: 'over-budget' | 'on-track' | 'unknown';
  /**
   * Sum of the per-optimization savings, in USD/mo. These are the MODEL's
   * public-list-price estimates (not authoritative billing), capped so the
   * total can never exceed the projection.
   */
  totalEstSavingsUsd: number;
  /** Authoritative pre-optimization month-end projection (Cost Explorer run-rate). */
  projectedMonthlyNowUsd: number;
  /**
   * Estimated month-end bill AFTER applying the optimizations: the authoritative
   * projection minus the model's (capped) estimated savings, floored at 0. The
   * base is authoritative; the savings subtracted from it are model estimates.
   */
  projectedMonthlyAfterUsd: number;
  drivers: CostDriver[];
  /** Non-obvious recurring drains the waste scan does not mechanically catch. */
  hiddenCosts: HiddenCost[];
  optimizations: CostOptimization[];
  /** Paste-ready instruction block for Claude Code to act via the AWS CLI. */
  claudeCodePlan: string;
}

const SYSTEM = `You are a senior AWS cost-optimization (FinOps) consultant. Teams hire people like you precisely because AWS bills hide costs they do not understand: long-running resources nobody remembers, over-provisioned infrastructure, data-transfer and per-request charges that quietly compound, and services that have a cheaper equivalent the team has never heard of. Your client is technical but NOT a billing expert. Give them the transparency a paid consultant would: name the skeletons in the closet, explain in plain English what each thing is for, and tell them what they could switch to, how much cheaper it is, and what their bill would look like afterward.

You are given a LIVE snapshot: month-to-date spend, a month-end projection, the per-service breakdown, their daily spend cap and the monthly budget it implies, and an automated waste scan (idle/duplicate NAT gateways, redundant VPC endpoints, unattached Elastic IPs, orphaned EBS volumes, surplus load balancers) with approximate recoverable amounts and real resource IDs. The waste scan only catches a few mechanical patterns — your job is to reason BEYOND it.

Deliver five things:
1. headline: a short plain-English read of what drives the bill and whether the projection is a problem vs their budget.
2. drivers: for each significant service, what it actually does, whether THIS account plausibly needs it at this spend, and — critically — a cheaper alternative if a credible one exists (with roughly how much it saves). Examples of real substitutions: gp2→gp3 EBS (~20% less), NAT Gateway→interface VPC endpoints or a NAT instance, on-demand EC2→Compute Savings Plans/Spot, Fargate↔Lambda depending on duty cycle, provisioned RDS→Aurora Serverless v2, single-AZ where Multi-AZ is not required, S3 lifecycle to IA/Glacier, CloudFront/VPC endpoints to cut data-egress, shorter CloudWatch Logs retention. If no good swap exists, say so (empty cheaperAlternative).
3. hiddenCosts: the non-obvious recurring drains the waste scan does NOT catch — the skeletons in the closet. Think: inter-AZ and internet data-transfer/egress, NAT gateway data-processing charges, aged EBS snapshots, forgotten dev/test resources left running, over-retentive log groups, idle RDS/ElastiCache, over-provisioned instance sizes, provisioned concurrency, EIPs/IPv4 charges. Each with an approximate monthly amount. Only include ones the spend pattern plausibly supports; do not fabricate.
4. optimizations: concrete fixes ranked by payoff (biggest, safest first). For substitutions set the alternative and the estimated new monthly cost so the client sees the before/after. Ground them in the data; if the bill is genuinely lean, say so and give monitoring/right-sizing follow-ups rather than inventing waste.
5. claudeCodePlan: a single paste-ready plan the client hands to Claude Code to execute via the AWS CLI (v2, already configured).

Rules for claudeCodePlan:
- It is a prompt addressed to Claude Code. Start by telling it to VERIFY before changing anything: the read-only "aws ... describe/get/list" commands (correct --region per resource) that confirm each flagged resource is really idle, and the cost-discovery commands to investigate the hidden costs (e.g. "aws ce get-cost-and-usage" grouped by USAGE_TYPE to expose data-transfer, "aws ec2 describe-snapshots", "aws logs describe-log-groups").
- Then the remediation/substitution commands. Put every destructive command (delete/release/deregister/modify) in its own clearly labelled step that says to confirm with the user first; never chain a delete so it would run automatically.
- RESOURCE-ID SAFETY (this is a shared AWS account — a wrong ID deletes the wrong thing): only ever write a literal resource ID if it appears VERBATIM in the WASTE SCAN section below. For any resource that is NOT in the waste scan, do NOT invent an ID — instead the destructive step must consume the ID from the output of its own read-only describe in the verification step (e.g. tell Claude Code to capture the ID into a shell variable and confirm it with the user before acting). Never guess or fabricate an ARN/ID/region.
- Order steps by payoff and note the approximate monthly saving next to each.
- Copy-pasteable plain text, commands on their own lines. No fenced code blocks.
- Length and item counts: follow the OUTPUT BUDGET in the user message EXACTLY. A reply that fits the budget and is COMPLETE valid JSON always beats a longer one that gets cut off.

Output STRICT JSON and nothing else (no markdown, no code fences), exactly this shape:
{"headline":"<2-4 sentences>","verdict":"over-budget|on-track|unknown","drivers":[{"service":"<exact service name as given>","whatItIs":"<1-2 sentences, plain English>","necessity":"essential|review|likely-waste","assessment":"<1-3 sentences>","cheaperAlternative":"<a cheaper swap + rough saving, or empty>"}],"hiddenCosts":[{"title":"<short>","detail":"<what it is + why it is easy to miss>","estMonthlyUsd":<number>}],"optimizations":[{"title":"<short>","rationale":"<plain English>","alternative":"<what to switch to, or empty>","estMonthlySavingsUsd":<number>,"estNewMonthlyUsd":<number>,"effort":"low|medium|high","priority":"high|medium|low"}],"claudeCodePlan":"<the paste-ready plan>"}

More rules:
- For the "service" field of each driver, reuse the EXACT service name string from the breakdown so it can be matched back to its dollar figure. Cover the services that matter (top spenders); omit trivial sub-dollar line items.
- Be specific and name AWS services/controls. All dollar figures except the live snapshot are public-list-price estimates for ranking, not invoice reconciliation — do not claim exactness.
- This is decision support, not a guarantee. Do not put a disclaimer in the JSON; the UI shows one.`;

function tryParse(t: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(t);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort repair of a JSON object that was cut off mid-stream (the model
 * hit max_tokens). Walks the text tracking string/escape state and the open
 * brace/bracket stack, drops a dangling trailing comma, closes an unterminated
 * string, and appends the missing closers. Because claudeCodePlan is the LAST
 * field in the shape, the common truncation (a cut mid-plan string) recovers to
 * a fully valid object with only the plan clipped — everything else intact.
 */
function balanceTruncated(raw: string): string {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let out = raw;
  if (inStr) {
    if (esc) out = out.slice(0, -1); // drop a dangling escape so the close quote is literal
    out += '"';
  }
  out = out.replace(/,\s*$/, ''); // a trailing comma before the synthetic closers is invalid
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === '{' ? '}' : ']';
  return out;
}

/**
 * Parse the model's JSON, tolerating fenced output AND truncation. A truncated
 * body must NOT nuke the whole report (it is a paid call on real data), so we
 * fall back to: the first balanced {...} match, then a brace-balanced repair of
 * the tail, then a repair trimmed to the last complete object. Throws only when
 * nothing usable can be recovered.
 */
function extractJson(text: string): Record<string, unknown> {
  const t = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();

  let parsed = tryParse(t);
  if (parsed) return parsed;

  const m = t.match(/\{[\s\S]*\}/);
  if (m) {
    parsed = tryParse(m[0]);
    if (parsed) return parsed;
  }

  const start = t.indexOf('{');
  if (start >= 0) {
    // Tier 1: balance the whole tail (handles a cut mid-final-string).
    parsed = tryParse(balanceTruncated(t.slice(start)));
    if (parsed) return parsed;
    // Tier 2: trim to the last complete object close, then balance (handles a
    // cut mid-array-element by dropping the partial element).
    const lastBrace = t.lastIndexOf('}');
    if (lastBrace > start) {
      parsed = tryParse(balanceTruncated(t.slice(start, lastBrace + 1)));
      if (parsed) return parsed;
    }
  }

  throw new Error('model did not return valid JSON');
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function numOr0(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  const s = str(v).trim().toLowerCase();
  return (allowed as readonly string[]).includes(s) ? (s as T) : fallback;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

function moneyLine(label: string, n: number): string {
  return `${label}: ${usd(n)}`;
}

/** Compact, model-friendly rendering of the by-service breakdown. */
function serviceBlock(byService: CostServiceSlice[], monthToDateUsd: number): string {
  if (byService.length === 0) return '(no per-service breakdown available)';
  // Top 12 by spend is plenty to explain the bill; the tail is rounding noise.
  return byService
    .slice(0, 12)
    .map((s) => {
      const share = monthToDateUsd > 0 ? (s.amountUsd / monthToDateUsd) * 100 : 0;
      return `- ${s.service}: ${usd(s.amountUsd)} (${share.toFixed(0)}% of MTD)`;
    })
    .join('\n');
}

function riskBlock(risks: CostRisksResult): string {
  if (!risks.available) return `(waste scan unavailable: ${risks.note ?? 'unknown reason'})`;
  if (risks.risks.length === 0) {
    return `(no wasteful resources detected across ${risks.regionsScanned.join(', ') || 'the scanned regions'})`;
  }
  const head = `Regions scanned: ${risks.regionsScanned.join(', ') || 'n/a'}. Total recoverable ~${usd(
    risks.totalMonthlySavingsUsd,
  )}/mo.`;
  const lines = risks.risks.map((r) => {
    const ids = r.resourceIds.slice(0, 8).join(', ');
    const more = r.resourceIds.length > 8 ? ` (+${r.resourceIds.length - 8} more)` : '';
    return [
      `- [${r.severity.toUpperCase()}] ${r.title} — ${r.region}`,
      `  ${r.detail}`,
      `  costs ~${usd(r.estMonthlyUsd)}/mo, ~${usd(r.estMonthlySavingsUsd)}/mo recoverable`,
      r.resourceIds.length ? `  resources: ${ids}${more}` : '  resources: (none reported)',
    ].join('\n');
  });
  return [head, ...lines].join('\n');
}

/**
 * Re-attach the authoritative Cost Explorer dollar figures to the drivers the
 * model returned, matching on service name (normalized). The model supplies the
 * prose; the numbers stay ours. A driver the model named but we can't match
 * still renders (amount 0) rather than being dropped, and we never trust a
 * model-supplied dollar amount.
 */
function reconcileDrivers(
  raw: unknown,
  byService: CostServiceSlice[],
  monthToDateUsd: number,
): CostDriver[] {
  const arr = Array.isArray(raw) ? raw : [];
  const norm = (s: string) => s.trim().toLowerCase();
  const byName = new Map<string, CostServiceSlice>();
  for (const s of byService) byName.set(norm(s.service), s);

  // Dedupe by normalized service name (first wins): the model occasionally
  // repeats a service, which would otherwise collide on the React key and
  // double-count it in the UI.
  const seen = new Set<string>();
  const out: CostDriver[] = [];
  for (const d of arr) {
    const obj = (d ?? {}) as Record<string, unknown>;
    const service = str(obj.service).trim();
    const key = norm(service);
    if (!service || seen.has(key)) continue;
    seen.add(key);
    const match = byName.get(key);
    const amount = match ? match.amountUsd : 0;
    const share = monthToDateUsd > 0 ? (amount / monthToDateUsd) * 100 : 0;
    out.push({
      service: match ? match.service : service,
      monthToDateUsd: amount,
      sharePct: Math.round(share * 10) / 10,
      whatItIs: str(obj.whatItIs),
      necessity: oneOf<CostNecessity>(obj.necessity, ['essential', 'review', 'likely-waste'], 'review'),
      assessment: str(obj.assessment),
      cheaperAlternative: str(obj.cheaperAlternative),
    });
  }
  return out;
}

function parseHiddenCosts(raw: unknown): HiddenCost[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr
    .map((h) => {
      const obj = (h ?? {}) as Record<string, unknown>;
      const title = str(obj.title).trim();
      if (!title) return null;
      return { title, detail: str(obj.detail), estMonthlyUsd: numOr0(obj.estMonthlyUsd) };
    })
    .filter((x): x is HiddenCost => x !== null);
}

function parseOptimizations(raw: unknown): CostOptimization[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr
    .map((o) => {
      const obj = (o ?? {}) as Record<string, unknown>;
      const title = str(obj.title).trim();
      if (!title) return null;
      return {
        title,
        rationale: str(obj.rationale),
        alternative: str(obj.alternative),
        estMonthlySavingsUsd: numOr0(obj.estMonthlySavingsUsd),
        estNewMonthlyUsd: numOr0(obj.estNewMonthlyUsd),
        effort: oneOf(obj.effort, ['low', 'medium', 'high'] as const, 'medium'),
        priority: oneOf(obj.priority, ['high', 'medium', 'low'] as const, 'medium'),
      };
    })
    .filter((x): x is CostOptimization => x !== null);
}

export interface GenerateCostReportInput {
  summary: CostSummary;
  risks: CostRisksResult;
  /** Effective daily spend cap in USD (drives the implied monthly budget). */
  dailyCapUsd: number;
  /**
   * When true (async path, no 60s edge timeout), produce the fuller report:
   * more drivers/optimizations and a complete, untrimmed Claude Code plan, with
   * a higher token ceiling. When false/omitted (sync path), stay tight so it
   * returns under the CloudFront origin timeout.
   */
  rich?: boolean;
}

// The OUTPUT BUDGET handed to the model per call. Tight is sized to finish under
// the 60s edge timeout; rich is the thorough version the async path can afford.
const TIGHT_BUDGET =
  'OUTPUT BUDGET (a hard 60-second timeout fronts this — be fast AND complete): at most 4 drivers (the very top spenders), at most 3 hiddenCosts, at most 4 optimizations. EVERY prose field is ONE short sentence. The claudeCodePlan covers ONLY the top 3 actions and is under ~250 words. A short COMPLETE reply beats a long truncated one.';
const RICH_BUDGET =
  'OUTPUT BUDGET (generated in the background — no edge timeout, so be fuller than the inline version, but you MUST return COMPLETE valid JSON, so do not run on): up to 6 drivers, up to 5 hiddenCosts, up to 6 optimizations. Prose fields are 1-2 sentences. The claudeCodePlan is complete and untrimmed (full read-only verification then the remediation/substitution commands for each recommended action) but stays tight: under ~600 words, no preamble or repetition.';

/**
 * Generate the on-demand cost report. Throws on a model/parse failure so the
 * router can surface a clean 502; the caller should not retry blindly (the
 * model call is the expensive part). Returns available:false WITHOUT calling
 * the model when Cost Explorer data is missing.
 */
export async function generateCostReport(input: GenerateCostReportInput): Promise<CostReport> {
  const { summary, risks, dailyCapUsd, rich = false } = input;
  const generatedAt = new Date().toISOString();

  if (!summary.available) {
    return {
      generatedAt,
      modelId: MODEL,
      generationCostUsd: 0,
      available: false,
      note: summary.note ?? 'Cost Explorer data is unavailable, so no report could be generated.',
      headline: '',
      verdict: 'unknown',
      totalEstSavingsUsd: 0,
      projectedMonthlyNowUsd: 0,
      projectedMonthlyAfterUsd: 0,
      drivers: [],
      hiddenCosts: [],
      optimizations: [],
      claudeCodePlan: '',
    };
  }

  const monthBudgetUsd = dailyCapUsd > 0 ? dailyCapUsd * summary.daysInMonth : 0;
  const overBudget = monthBudgetUsd > 0 && summary.projectedMonthUsd > monthBudgetUsd;
  const momPct =
    summary.lastMonthUsd > 0
      ? ((summary.projectedMonthUsd - summary.lastMonthUsd) / summary.lastMonthUsd) * 100
      : null;

  const userText = [
    'LIVE BILL SNAPSHOT (figures are from AWS Cost Explorer; treat them as authoritative):',
    moneyLine('Month-to-date spend', summary.monthToDateUsd) +
      ` (day ${summary.daysElapsed} of ${summary.daysInMonth})`,
    moneyLine('Projected month-end', summary.projectedMonthUsd) +
      (momPct !== null ? ` (${momPct >= 0 ? '+' : ''}${momPct.toFixed(0)}% vs last month)` : ''),
    moneyLine('Last month total', summary.lastMonthUsd),
    dailyCapUsd > 0
      ? `Daily spend cap: ${usd(dailyCapUsd)} → implied monthly budget ${usd(monthBudgetUsd)}. Projection is ${
          overBudget ? `OVER budget by ${usd(summary.projectedMonthUsd - monthBudgetUsd)}` : 'within budget'
        }.`
      : 'No daily spend cap is set, so there is no budget to compare the projection against.',
    '',
    'PER-SERVICE BREAKDOWN (month to date, top spenders first):',
    serviceBlock(summary.byService, summary.monthToDateUsd),
    '',
    'AUTOMATED WASTE SCAN:',
    riskBlock(risks),
    '',
    rich ? RICH_BUDGET : TIGHT_BUDGET,
    '',
    'Produce the JSON described in your instructions for THIS account, grounded in the numbers above. Use the exact service names from the breakdown in your driver entries.',
  ].join('\n');

  let out;
  try {
    out = await converseTurn({
      modelId: MODEL,
      systemPrompt: SYSTEM,
      userText,
      // Tight path: sized to finish under the 60s CloudFront origin-read timeout
      // (~4 drivers / 3 hidden / 4 optimizations / <250-word plan ≈ ~45s). Rich
      // path (async job, no edge timeout): a generous ceiling for the full,
      // untrimmed report. extractJson recovers a clipped body either way.
      maxTokens: rich ? 8000 : 2400,
      temperature: 0.3,
    });
  } catch (err) {
    logger.warn(
      { errMessage: err instanceof Error ? err.message : String(err) },
      'cost-analyst: model call failed',
    );
    throw err;
  }

  // A truncated body (model hit the token ceiling) is recoverable by
  // extractJson, but the tail fields (the CLI plan) may be clipped — flag it so
  // the UI can tell the user to regenerate rather than silently showing a
  // half-written plan.
  const truncated = out.stopReason === 'max_tokens';
  if (truncated) {
    logger.warn({ outputTokens: out.outputTokens }, 'cost-analyst: response hit max_tokens (truncated)');
  }

  const parsed = extractJson(out.text ?? '');

  const drivers = reconcileDrivers(parsed.drivers, summary.byService, summary.monthToDateUsd);
  const hiddenCosts = parseHiddenCosts(parsed.hiddenCosts);
  const optimizations = parseOptimizations(parsed.optimizations);
  // Per-optimization savings are MODEL estimates. Cap the running total at the
  // projection so a hallucinated figure can never claim you save more than the
  // whole bill (which would make the before/after numbers nonsense).
  const rawSavings = optimizations.reduce((s, o) => s + Math.max(0, o.estMonthlySavingsUsd), 0);
  const totalEstSavingsUsd = Math.round(Math.min(rawSavings, summary.projectedMonthUsd) * 100) / 100;
  // Authoritative pre-optimization projection (Cost Explorer run-rate). The UI
  // renders this directly as "Projected now" rather than reconstructing it.
  const projectedMonthlyNowUsd = Math.round(summary.projectedMonthUsd * 100) / 100;
  // After-bill: authoritative base minus the (capped) model-estimated savings,
  // floored at 0. Base is authoritative; the subtracted savings are estimates.
  const projectedMonthlyAfterUsd =
    Math.round(Math.max(0, summary.projectedMonthUsd - totalEstSavingsUsd) * 100) / 100;

  // Verdict is the authoritative projection-vs-budget call when a budget exists;
  // we do not let the model's verdict contradict the numbers we computed.
  const verdict: CostReport['verdict'] =
    monthBudgetUsd > 0 ? (overBudget ? 'over-budget' : 'on-track') : 'unknown';

  return {
    generatedAt,
    modelId: out.modelId,
    generationCostUsd: out.costUsd,
    available: true,
    note: truncated
      ? 'To fit the time budget, the Claude Code plan may be trimmed at the end. The analysis and recommendations above are complete.'
      : undefined,
    headline: str(parsed.headline),
    verdict,
    totalEstSavingsUsd,
    projectedMonthlyNowUsd,
    projectedMonthlyAfterUsd,
    drivers,
    hiddenCosts,
    optimizations,
    claudeCodePlan: str(parsed.claudeCodePlan),
  };
}

export { MODEL as COST_MODEL };
