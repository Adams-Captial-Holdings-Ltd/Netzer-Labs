/**
 * Read-only WAF posture reader (Tier B).
 *
 * Discovers the regional WebACL guarding the orchestrator and reports
 * green/amber/red cards for the things a reviewer cares about:
 *
 *   - Is a WebACL present and protecting a resource at all?
 *   - Are AWS managed rule groups present (common rule set, etc.)?
 *   - Is a rate-based rule configured, and at what limit?
 *   - Is the anonymous-IP / known-bad-input protection present?
 *
 * Discovery, not env injection: the WebACL arn cannot be passed into the
 * compute stack without forming a cross-stack cycle (security depends on
 * compute), so we resolve it at runtime. We use wafv2:ListWebACLs to find
 * the ACL whose name matches our deterministic prefix, GetWebACL to read
 * its rules, and ListResourcesForWebACL to confirm it is associated with a
 * live resource (the ALB). This avoids depending on the ELBv2 SDK client,
 * which is not a project dependency.
 *
 * Every AWS call is wrapped so a denied permission or a tier with no WAF
 * (T0 / T1 ship without WAF) degrades to an 'unknown' card instead of a
 * 500. No secret values are ever returned.
 */

import {
  WAFV2Client,
  GetWebACLCommand,
  ListWebACLsCommand,
  ListResourcesForWebACLCommand,
  type Rule,
  type WebACL,
} from '@aws-sdk/client-wafv2';
import { logger } from '../../observability/logger.js';
import type { PostureCard } from '../../adapters/dashboard/posture-network.js';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
// ALB / WebACL names follow the deterministic naming convention. CDK
// overrides the app prefix via CCE_RESOURCE_PREFIX for staging deploys.
const PREFIX = process.env.CCE_RESOURCE_PREFIX ?? 'claudeclaw';

let _waf: WAFV2Client | null = null;

function waf(): WAFV2Client {
  if (!_waf) _waf = new WAFV2Client({ region: REGION });
  return _waf;
}

/** Test seam: inject a fake, or null to force re-create. */
export function __setWafClients(next: { waf?: WAFV2Client | null } = {}): void {
  if ('waf' in next) _waf = next.waf ?? null;
}

/**
 * Discover the regional WebACL guarding the orchestrator. Lists regional
 * ACLs, picks the one whose name matches our prefix, then GetWebACL for
 * the full rule set. Returns undefined when none matches (T0/T1) so the
 * caller emits 'unknown' cards.
 */
async function discoverWebAcl(): Promise<WebACL | undefined> {
  // WAFv2 paginates with NextMarker (not NextToken).
  let marker: string | undefined;
  let match: { Id: string; Name: string } | undefined;
  do {
    const list = await waf().send(
      new ListWebACLsCommand({ Scope: 'REGIONAL', NextMarker: marker }),
    );
    const found = (list.WebACLs ?? []).find((w) =>
      (w.Name ?? '').startsWith(PREFIX),
    );
    if (found?.Id && found.Name) {
      match = { Id: found.Id, Name: found.Name };
      break;
    }
    marker = list.NextMarker;
  } while (marker);

  if (!match) return undefined;

  const got = await waf().send(
    new GetWebACLCommand({ Scope: 'REGIONAL', Id: match.Id, Name: match.Name }),
  );
  return got.WebACL;
}

function unknownCard(id: string, label: string, detail: string): PostureCard {
  return { id, label, status: 'unknown', detail };
}

/** Does any rule reference an AWS managed rule group? */
function managedRuleGroups(rules: Rule[]): string[] {
  const names: string[] = [];
  for (const r of rules) {
    const stmt = r.Statement?.ManagedRuleGroupStatement;
    if (stmt?.Name) names.push(stmt.Name);
  }
  return names;
}

/** First rate-based rule limit, if any. */
function rateLimit(rules: Rule[]): number | undefined {
  for (const r of rules) {
    const limit = r.Statement?.RateBasedStatement?.Limit;
    if (typeof limit === 'number') return limit;
  }
  return undefined;
}

/** Is the anonymous-IP managed group present (blocks VPNs / hosting / Tor)? */
function hasAnonymousIpProtection(names: string[]): boolean {
  return names.includes('AWSManagedRulesAnonymousIpList');
}

/**
 * Build the four WAF posture cards. Fail-soft: any error yields an
 * 'unknown' card explaining that T0/T1 tiers may legitimately have no WAF.
 */
export async function readWafPosture(): Promise<PostureCard[]> {
  let acl: WebACL | undefined;
  try {
    acl = await discoverWebAcl();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ errMessage: msg }, 'posture: waf discovery failed');
    return [
      unknownCard(
        'waf-enabled',
        'WAF enabled',
        `Could not read WAF config (${msg}). T0/T1 tiers ship without a WAF.`,
      ),
    ];
  }

  if (!acl) {
    return [
      unknownCard(
        'waf-enabled',
        'WAF enabled',
        'No WebACL matching the app prefix. Expected on T0/T1 tiers, which ship without a WAF.',
      ),
    ];
  }

  // Confirm the ACL actually protects a resource (best-effort, non-fatal).
  let protectedCount: number | undefined;
  if (acl.ARN) {
    const res = await waf()
      .send(new ListResourcesForWebACLCommand({ WebACLArn: acl.ARN }))
      .catch(() => undefined);
    protectedCount = res?.ResourceArns?.length;
  }

  const rules = acl.Rules ?? [];
  const managed = managedRuleGroups(rules);
  const limit = rateLimit(rules);
  const anonIp = hasAnonymousIpProtection(managed);

  const cards: PostureCard[] = [];

  cards.push({
    id: 'waf-enabled',
    label: 'WAF enabled',
    // An ACL with zero protected resources is configured but not guarding
    // traffic, so warn rather than green it.
    status: protectedCount === 0 ? 'warn' : 'ok',
    detail:
      protectedCount && protectedCount > 0
        ? `WebACL ${acl.Name ?? '(unnamed)'} associated with ${protectedCount} resource(s).`
        : protectedCount === 0
          ? `WebACL ${acl.Name ?? '(unnamed)'} present but not associated with any resource.`
          : `WebACL ${acl.Name ?? '(unnamed)'} present.`,
    ...(acl.Name ? { value: acl.Name } : {}),
  });

  cards.push({
    id: 'waf-managed-rules',
    label: 'Managed rule groups',
    status: managed.length > 0 ? 'ok' : 'warn',
    detail:
      managed.length > 0
        ? `AWS managed rule groups active: ${managed.join(', ')}.`
        : 'No AWS managed rule groups configured on the WebACL.',
    ...(managed.length > 0 ? { value: String(managed.length) } : {}),
  });

  cards.push({
    id: 'waf-rate-limit',
    label: 'Rate-based rule',
    status: limit !== undefined ? 'ok' : 'warn',
    detail:
      limit !== undefined
        ? `Rate-based rule limits requests to ${limit} per 5-minute window per IP.`
        : 'No rate-based rule configured on the WebACL.',
    ...(limit !== undefined ? { value: String(limit) } : {}),
  });

  cards.push({
    id: 'waf-anonymous-ip',
    label: 'Anonymous-IP block',
    status: anonIp ? 'ok' : 'warn',
    detail: anonIp
      ? 'AWSManagedRulesAnonymousIpList active (blocks VPN / hosting / Tor sources).'
      : 'Anonymous-IP managed rule group not present.',
  });

  return cards;
}
