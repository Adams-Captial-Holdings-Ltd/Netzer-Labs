/**
 * Netzar OS Enterprise · Bootstrap (onboarding Phase 3).
 *
 * `npm run bootstrap`
 *
 * The FIRST mutating phase of self-host. Everything before it (doctor, the
 * isolation scan, early-win) is read-only or zero-resource. This phase stands up
 * the minimal, owned, destroyable foundation the deploy needs, in a strict order
 * that fails closed at every step:
 *
 *   (a) RE-RUN the deny-by-default isolation scan + account-profile detection.
 *       HARD BLOCK (fail envelope, non-zero exit, NO override) on a not-empty or
 *       unsupported-account-profile verdict. The scan in doctor was advisory; the
 *       account state can change between doctor and bootstrap, so we re-prove it
 *       here right before the first write. There is no flag to skip this.
 *
 *   (b) ARM the TTL tripwire as the FIRST mutating action, write-ahead. The
 *       tripwire is the durable, AWS-side backstop that auto-destroys an install
 *       that never reaches 'verified'. We record the WRITE-AHEAD INTENT in
 *       run-state (armTripwire) BEFORE the CDK deploy of the tripwire stack, so a
 *       crash between intent and deploy still leaves a record the destroy sweep
 *       can act on. Actually deploying the tripwire stack is a CDK call; this CLI
 *       records the intent and surfaces a clearly-typed, fail-closed TODO check
 *       (status 'pending') at the live deploy point for the orchestrator to
 *       complete, rather than faking success.
 *
 *   (c) CREATE the unique-qualifier CDK toolkit + the state primitives (state
 *       bucket, lock table, ECR repo), REUSING bootstrap-state.ts naming. The
 *       toolkit is deployed under OUR qualifier and OUR stack name
 *       (ClaudeClawToolkit); we REFUSE to ride a foreign / default CDKToolkit via
 *       naming.isForeignToolkit. Each primitive is write-ahead recorded BEFORE
 *       its create call.
 *
 *   (d) MINT the scoped deploy role with the permission boundary (scoped-role
 *       builders): the boundary makes every off-account-foothold and cost-cap
 *       mutation technically impossible, no matter what identity policy is later
 *       attached. Write-ahead recorded before the create.
 *
 *   (e) WRITE run-state + manifest, then assertNoStrongerAdminCredential and
 *       record that the agent should now assume the scoped role for everything
 *       after bootstrap.
 *
 * Idempotent + resumable: on start we readRunState and resume per phase. Each
 * create is preceded by a write-ahead inventory row, so an interrupt is always
 * recoverable. Every check carries a typed Action and the whole run emits ONE
 * typed Envelope (command 'bootstrap').
 *
 * Where a step needs a LIVE account and this CLI cannot fully execute it without
 * one, the real control flow is written and the live AWS mutation point is
 * marked with a clearly-typed, fail-closed TODO (a 'pending' check) rather than
 * faking success. A 'pending' check keeps the envelope not-ok by construction
 * (Envelope.ok === fail===0 && pending===0), so a half-bootstrapped run never
 * reads as done.
 *
 * Import-safe: NO top-level side effects. No AWS client is constructed and no
 * call is made at module load; everything runs inside main(), invoked only
 * behind the import.meta.url guard. No em dashes by house rule.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from './lib/ansi.js';
import { parseEnvFile, resolveEnvFlag, envFileNameFor } from './lib/env-file.js';
import {
  makeCheck,
  makeEnvelope,
  noneAction,
  humanGateAction,
  runCommandAction,
  printEnvelope,
  type Check,
  type Envelope,
} from './lib/envelope/envelope.js';
import {
  runIsolationScan,
  type ScanResult,
} from './lib/isolation/scanner.js';
import {
  detectAccountProfile,
  type AccountProfileResult,
} from './lib/isolation/account-profile.js';
import {
  resolveStateNames,
  bootstrapQualifier,
  toolkitStackName,
  isForeignToolkit,
  onboardingTags,
  CDK_DEFAULT_TOOLKIT_STACK,
  type StateNames,
} from './lib/onboarding/naming.js';
import {
  buildScopedDeployBoundary,
  buildScopedDeployRoleTrust,
  assertNoStrongerAdminCredential,
  SCOPED_ROLE_PROFILE_NAME,
} from './lib/onboarding/scoped-role.js';
import {
  initRunState,
  readRunState,
  recordPlannedResource,
  armTripwire,
  patchBootstrap,
  setPhase,
  setMode,
  setResumeClass,
  setStatus,
  type RunState,
  type InventoryItem,
} from './lib/run-state/run-state.js';

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

/** Default tripwire grace window (hours) before an unverified install self-destructs. */
export const BOOTSTRAP_TRIPWIRE_TTL_HOURS = 6;

/** The scoped deploy role name onboarding mints (matches the scoped-role profile). */
export const SCOPED_DEPLOY_ROLE_NAME = 'claudeclaw-scoped-deploy';

// Stable check ids so the orchestrator can match on them across runs.
export const CHECK_ISOLATION = 'bootstrap-isolation-scan';
export const CHECK_ACCOUNT_PROFILE = 'bootstrap-account-profile';
export const CHECK_TRIPWIRE = 'bootstrap-tripwire-armed';
export const CHECK_TOOLKIT = 'bootstrap-cdk-toolkit';
export const CHECK_STATE_PRIMITIVES = 'bootstrap-state-primitives';
export const CHECK_SCOPED_ROLE = 'bootstrap-scoped-deploy-role';
export const CHECK_CREDENTIAL_GUARD = 'bootstrap-credential-guard';
export const CHECK_ASSUME_ROLE = 'bootstrap-assume-scoped-role';

/** Gate ids surfaced when a human / orchestrator must act. */
export const GATE_ACCOUNT_NOT_EMPTY = 'account-not-empty';
export const GATE_UNSUPPORTED_PROFILE = 'unsupported-account-profile';
export const GATE_DEPLOY_TOOLKIT = 'deploy-cdk-toolkit';

// ─────────────────────────────────────────────────────────────────────
// Resolved bootstrap context
// ─────────────────────────────────────────────────────────────────────

export interface BootstrapContext {
  env: Record<string, string>;
  account: string;
  region: string;
  mode: 'chat' | 'infra-only';
  names: StateNames;
  qualifier: string;
  toolkitStack: string;
}

/**
 * Resolve account / region / names / qualifier from the env. THROWS a readable
 * error when account or region is missing (the names + trust policy require a
 * 12-digit account, and the qualifier is derived from account + region).
 */
export function resolveBootstrapContext(env: Record<string, string>): BootstrapContext {
  const account = env.AWS_ACCOUNT_ID?.trim() ?? '';
  const region = env.AWS_REGION?.trim() ?? '';
  if (!/^\d{12}$/.test(account)) {
    throw new Error(
      'bootstrap needs a 12-digit AWS_ACCOUNT_ID in the env (the scoped-role trust policy and the ' +
        'deterministic resource names require it). Run `npm run setup` first.',
    );
  }
  if (!region) {
    throw new Error('bootstrap needs AWS_REGION in the env. Run `npm run setup` first.');
  }
  const names = resolveStateNames(env);
  const qualifier = bootstrapQualifier(account, region);
  const toolkitStack = toolkitStackName();
  const mode: 'chat' | 'infra-only' = env.CCE_DEPLOY_MODE === 'infra-only' ? 'infra-only' : 'chat';
  return { env, account, region, mode, names, qualifier, toolkitStack };
}

// ─────────────────────────────────────────────────────────────────────
// (a) Isolation + account-profile re-run (HARD BLOCK; no override)
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the two guard checks. A not-empty / indeterminate scan or an
 * unsupported account profile produces a FAIL check (status 'fail') carrying the
 * inert findings in check.data and a human gate. There is deliberately no
 * override path: bootstrap must not write into an account it cannot prove empty
 * and standalone.
 */
export function buildPreflightGuardChecks(
  scan: ScanResult,
  profile: AccountProfileResult,
): { ok: boolean; checks: Check[] } {
  const checks: Check[] = [];

  // Isolation scan.
  if (scan.verdict === 'empty') {
    checks.push(
      makeCheck({
        id: CHECK_ISOLATION,
        title: 'Account is empty (deny-by-default isolation scan)',
        status: 'pass',
        detail: `scanned ${scan.scannedRegions.length} region(s); zero non-allowlisted resources found`,
        data: { verdict: scan.verdict, scannedRegions: scan.scannedRegions },
        action: noneAction(),
      }),
    );
  } else {
    const isNotEmpty = scan.verdict === 'not-empty';
    checks.push(
      makeCheck({
        id: CHECK_ISOLATION,
        title: 'Account is empty (deny-by-default isolation scan)',
        status: 'fail',
        detail: isNotEmpty
          ? `the account is NOT empty: ${scan.findings.length} non-allowlisted resource(s) found. ` +
            'bootstrap refuses to provision into a non-empty account (a stray resource can never be ' +
            'told apart from ours, nor swept clean). Use a fresh standalone account.'
          : `the scan is INDETERMINATE (could not prove emptiness): ${scan.unscannedRegions.length} ` +
            `unscanned region(s) and ${scan.unevaluable.length} unevaluable probe(s). Failing closed; ` +
            'fix credentials / region access and re-run. An unprovable account is never treated as empty.',
        data: {
          verdict: scan.verdict,
          findings: scan.findings,
          unevaluable: scan.unevaluable,
          unscannedRegions: scan.unscannedRegions,
          scannerVersion: scan.scannerVersion,
        },
        action: humanGateAction(GATE_ACCOUNT_NOT_EMPTY),
      }),
    );
  }

  // Account profile.
  if (profile.supported && profile.profile === 'standalone') {
    checks.push(
      makeCheck({
        id: CHECK_ACCOUNT_PROFILE,
        title: 'Account is standalone (not org-managed / Control-Tower-governed)',
        status: 'pass',
        detail: 'Organizations reports not-in-org and no Control Tower landing zone was observed',
        data: { profile: profile.profile, reasons: profile.reasons },
        action: noneAction(),
      }),
    );
  } else {
    checks.push(
      makeCheck({
        id: CHECK_ACCOUNT_PROFILE,
        title: 'Account is standalone (not org-managed / Control-Tower-governed)',
        status: 'fail',
        detail:
          `unsupported account profile "${profile.profile}": ${profile.reasons.join('; ')}. ` +
          'bootstrap only supports a standalone account it owns outright; an Org SCP or a Control ' +
          'Tower guardrail can void the isolation + scoped-role guarantees. Use a standalone account.',
        data: { profile: profile.profile, reasons: profile.reasons, supported: profile.supported },
        action: humanGateAction(GATE_UNSUPPORTED_PROFILE),
      }),
    );
  }

  const ok = scan.verdict === 'empty' && profile.supported && profile.profile === 'standalone';
  return { ok, checks };
}

// ─────────────────────────────────────────────────────────────────────
// Write-ahead inventory helpers
// ─────────────────────────────────────────────────────────────────────

function plannedItem(
  id: string,
  type: string,
  region: string,
): InventoryItem {
  return {
    id,
    type,
    phase: 3,
    plannedAt: new Date().toISOString(),
    region,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Live-mutation TODO check builder (fail-closed 'pending')
// ─────────────────────────────────────────────────────────────────────

/**
 * A clearly-typed, fail-closed TODO for a live AWS mutation this CLI cannot
 * complete without a live account. It is a 'pending' check (NOT a fake pass), so
 * the envelope stays not-ok until the orchestrator performs the mutation and
 * re-runs. The next command to run is carried as a typed run_command action so
 * the orchestrator knows exactly what to invoke; no AWS prose ever rides the
 * action.
 */
function liveMutationPending(opts: {
  id: string;
  title: string;
  detail: string;
  data?: unknown;
}): Check {
  return makeCheck({
    id: opts.id,
    title: opts.title,
    status: 'pending',
    detail: opts.detail,
    data: opts.data,
    // The orchestrator completes the live mutation, then re-runs bootstrap to
    // resume the next phase. A run_command action names that re-run explicitly.
    action: runCommandAction('bootstrap'),
  });
}

// ─────────────────────────────────────────────────────────────────────
// Phase builders (each records write-ahead intent, then emits a typed check)
// ─────────────────────────────────────────────────────────────────────

/**
 * (b) Arm the tripwire. Records the WRITE-AHEAD INTENT in run-state
 * (armTripwire) BEFORE the live CDK deploy of the tripwire stack, then emits a
 * fail-closed 'pending' TODO for the actual stack deploy. The intent is recorded
 * even though the deploy is deferred, so a crash here still leaves a record the
 * destroy sweep can act on. This is deliberately the FIRST mutating action.
 */
export function armTripwirePhase(ctx: BootstrapContext, state: RunState, cwd: string): Check {
  // Write-ahead: record the tripwire-stack as a planned resource, then stamp the
  // arm intent on the bootstrap sub-record. Both happen BEFORE any live deploy.
  const tripwireStack = `ClaudeClawTripwire-${state.runId}`;
  recordPlannedResource(plannedItem(tripwireStack, 'cloudformation:tripwire-stack', ctx.region), cwd);
  armTripwire(new Date().toISOString(), cwd);

  // The live action is a CDK deploy of infra/lib/tripwire-stack.ts
  // (TripwireStack), parameterized with installId === run id, ttlHours, and the
  // typed owned-resource lists. That requires a live account, so it is a typed
  // fail-closed TODO the orchestrator completes.
  return liveMutationPending({
    id: CHECK_TRIPWIRE,
    title: 'TTL tripwire armed (auto-destroy if not verified in time)',
    detail:
      `tripwire arm INTENT recorded write-ahead (run-state.bootstrap.tripwireArmed=true). ` +
      `TODO (orchestrator, live): deploy TripwireStack as stack "${tripwireStack}" with ` +
      `installId="${state.runId}", ttlHours=${BOOTSTRAP_TRIPWIRE_TTL_HOURS}, and the owned-resource ` +
      'lists, BEFORE any other stack. This is the first mutating action; it must succeed before ' +
      'the toolkit / state primitives are created.',
    data: {
      tripwireStack,
      installId: state.runId,
      ttlHours: BOOTSTRAP_TRIPWIRE_TTL_HOURS,
      ownerTags: onboardingTags(state.runId),
    },
  });
}

/**
 * (c1) Create the unique-qualifier CDK toolkit. REFUSES a foreign / default
 * CDKToolkit: we only ever trust the stack WE name (ClaudeClawToolkit). When the
 * configured toolkit stack name is foreign, this is a FAIL (not a pending TODO):
 * riding someone else's bootstrap is never acceptable. Otherwise it records the
 * toolkit as a planned resource and emits a fail-closed 'pending' TODO for the
 * live `cdk bootstrap` under our qualifier.
 */
export function toolkitPhase(ctx: BootstrapContext, cwd: string): Check {
  if (isForeignToolkit(ctx.toolkitStack)) {
    return makeCheck({
      id: CHECK_TOOLKIT,
      title: 'CDK toolkit under our own qualifier (never the default CDKToolkit)',
      status: 'fail',
      detail:
        `the configured toolkit stack "${ctx.toolkitStack}" is not our own toolkit stack name ` +
        `("${toolkitStackName()}"). bootstrap refuses to adopt or mutate a foreign / default ` +
        'CDKToolkit; it only ever trusts the toolkit it names. Do not point bootstrap at an ' +
        'existing CDKToolkit.',
      data: { configuredToolkitStack: ctx.toolkitStack, ourToolkitStack: toolkitStackName() },
      action: humanGateAction(GATE_DEPLOY_TOOLKIT),
    });
  }

  recordPlannedResource(
    plannedItem(ctx.toolkitStack, 'cloudformation:cdk-toolkit', ctx.region),
    cwd,
  );

  return liveMutationPending({
    id: CHECK_TOOLKIT,
    title: 'CDK toolkit under our own qualifier (never the default CDKToolkit)',
    detail:
      `toolkit create INTENT recorded write-ahead. TODO (orchestrator, live): run ` +
      `cdk bootstrap under qualifier "${ctx.qualifier}" and toolkit stack "${ctx.toolkitStack}" ` +
      `(NOT the default "${CDK_DEFAULT_TOOLKIT_STACK}"), tagged with the onboarding owner tags. ` +
      'Deriving our own qualifier + stack name is what makes a foreign default CDKToolkit ' +
      'detectable and keeps our bootstrap from being confused with another team bootstrap.',
    data: {
      qualifier: ctx.qualifier,
      toolkitStack: ctx.toolkitStack,
      defaultToolkitStack: CDK_DEFAULT_TOOLKIT_STACK,
    },
  });
}

/**
 * (c2) Create the state primitives (state bucket, lock table, ECR repo),
 * REUSING bootstrap-state.ts naming via resolveStateNames. Each primitive is
 * write-ahead recorded BEFORE the create. The live create
 * (bootstrapState / ensureStateBucket / ensureLockTable / ensureEcrRepo) needs a
 * live account, so it is surfaced as a fail-closed 'pending' TODO; the names are
 * persisted onto run-state.bootstrap so the destroy sweep can find them
 * regardless of how far the live create got.
 */
export function statePrimitivesPhase(ctx: BootstrapContext, cwd: string): Check {
  const { stateBucket, lockTable, ecrRepo } = ctx.names;

  // Write-ahead BEFORE the create: one inventory row per primitive.
  recordPlannedResource(plannedItem(stateBucket, 's3:state-bucket', ctx.region), cwd);
  recordPlannedResource(plannedItem(lockTable, 'dynamodb:lock-table', ctx.region), cwd);
  recordPlannedResource(plannedItem(ecrRepo, 'ecr:repository', ctx.region), cwd);
  // Persist the resolved names onto the bootstrap sub-record so a later sweep
  // has the exact identifiers even if the live create is interrupted.
  patchBootstrap({ stateBucket, lockTable, ecrRepo }, cwd);

  return liveMutationPending({
    id: CHECK_STATE_PRIMITIVES,
    title: 'State primitives (state bucket, lock table, ECR repo)',
    detail:
      'state-primitive create INTENT recorded write-ahead (names persisted to ' +
      'run-state.bootstrap). TODO (orchestrator, live): call bootstrapState(...) from ' +
      'scripts/lib/lifecycle/bootstrap-state.ts to idempotently create + validate the versioned, ' +
      'SSE, public-access-blocked state bucket, the on-demand lock table (wait ACTIVE), and the ' +
      'private ECR repo, tagged with the onboarding owner tags.',
    data: {
      stateBucket,
      lockTable,
      ecrRepo,
      ownerTags: onboardingTags(readRunState(cwd)?.runId ?? ''),
    },
  });
}

/**
 * (d) Mint the scoped deploy role with the permission boundary. Builds the
 * boundary + trust policy (pure, no AWS), write-ahead records the role, then
 * surfaces a fail-closed 'pending' TODO for the live IAM create. The boundary is
 * what makes the forbidden mutations technically impossible regardless of any
 * identity policy later attached.
 */
export function scopedRolePhase(ctx: BootstrapContext, cwd: string): Check {
  const boundary = buildScopedDeployBoundary();
  const trust = buildScopedDeployRoleTrust(ctx.account);
  const roleArn = `arn:aws:iam::${ctx.account}:role/${SCOPED_DEPLOY_ROLE_NAME}`;

  recordPlannedResource(plannedItem(roleArn, 'iam:scoped-deploy-role', ctx.region), cwd);
  patchBootstrap({ scopedRoleArn: roleArn }, cwd);

  return liveMutationPending({
    id: CHECK_SCOPED_ROLE,
    title: 'Scoped deploy role with permission boundary (foothold + cost-cap denies)',
    detail:
      `scoped-role create INTENT recorded write-ahead (arn persisted to run-state.bootstrap). ` +
      `TODO (orchestrator, live): create IAM role "${SCOPED_DEPLOY_ROLE_NAME}" with the trust policy ` +
      '(same-account assume only, federated assume denied) and ATTACH the permission boundary that ' +
      'denies every off-account-foothold class and every cost-cap / budget mutation. The boundary ' +
      'is an upper bound: it caps the role no matter what identity policy is later attached.',
    data: {
      roleArn,
      roleName: SCOPED_DEPLOY_ROLE_NAME,
      permissionBoundary: boundary,
      trustPolicy: trust,
      ownerTags: onboardingTags(readRunState(cwd)?.runId ?? ''),
    },
  });
}

// ─────────────────────────────────────────────────────────────────────
// (e) Credential guard + assume-role record
// ─────────────────────────────────────────────────────────────────────

/**
 * Run assertNoStrongerAdminCredential and build its check. A stronger / admin
 * credential discoverable in the environment is a FAIL: after bootstrap, every
 * deploy must run AS the scoped role (a temporary session), not a forgotten
 * admin key that would silently grant back everything the boundary removed.
 */
export async function credentialGuardCheck(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Check> {
  const guard = await assertNoStrongerAdminCredential(env);
  if (guard.ok) {
    return makeCheck({
      id: CHECK_CREDENTIAL_GUARD,
      title: 'No stronger admin credential than the scoped role is discoverable',
      status: 'pass',
      detail:
        'the environment carries no long-lived admin key, non-scoped profile, or SSO session that ' +
        'could override the scoped deploy role',
      action: noneAction(),
    });
  }
  return makeCheck({
    id: CHECK_CREDENTIAL_GUARD,
    title: 'No stronger admin credential than the scoped role is discoverable',
    status: 'fail',
    detail: guard.reason ?? 'a credential stronger than the scoped role is present; failing closed',
    data: { reason: guard.reason },
    action: noneAction(),
  });
}

/**
 * The terminal record: after bootstrap, the agent must assume the scoped role
 * for everything downstream. Always 'pending' until the orchestrator actually
 * assumes the role and re-runs under it, because nothing here can verify the
 * active identity is the scoped session.
 */
export function assumeScopedRoleCheck(ctx: BootstrapContext): Check {
  const roleArn = `arn:aws:iam::${ctx.account}:role/${SCOPED_DEPLOY_ROLE_NAME}`;
  return liveMutationPending({
    id: CHECK_ASSUME_ROLE,
    title: 'Assume the scoped deploy role for all post-bootstrap work',
    detail:
      `TODO (orchestrator, live): assume "${roleArn}" (profile "${SCOPED_ROLE_PROFILE_NAME}", a ` +
      'temporary session) and run every subsequent command (setup, deploy, verify, destroy) AS that ' +
      'scoped session. Do NOT continue under the bootstrap admin identity; the boundary only ' +
      'protects work that actually runs as the scoped role.',
    data: { roleArn, profile: SCOPED_ROLE_PROFILE_NAME },
  });
}

// ─────────────────────────────────────────────────────────────────────
// Orchestration (pure-ish: scan/profile injected; run-state cwd injected)
// ─────────────────────────────────────────────────────────────────────

export interface RunBootstrapDeps {
  /** The re-run isolation scan result (a not-empty / indeterminate verdict HARD BLOCKS). */
  scan: ScanResult;
  /** The re-run account-profile result (anything but supported standalone HARD BLOCKS). */
  profile: AccountProfileResult;
  /** Process env for the credential guard. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** run-state working dir. Defaults to process.cwd(). */
  cwd?: string;
}

/**
 * Assemble the full bootstrap envelope from the (already-run) scan + profile and
 * the resolved context. This is the pure heart of the CLI: it never makes an AWS
 * call itself (the scan/profile are injected; the live mutations are typed
 * 'pending' TODOs), so it is fully unit-testable. It DOES touch run-state
 * (write-ahead inventory + bootstrap sub-record), which is the durable spine the
 * resume + destroy paths depend on.
 *
 * Order of operations matches the plan exactly:
 *   (a) guard -> hard block on fail (return early, no further mutation recorded)
 *   (b) arm tripwire (first mutating action, write-ahead)
 *   (c) toolkit, then state primitives (write-ahead per create)
 *   (d) scoped role (write-ahead)
 *   (e) credential guard + assume-role record
 */
export async function runBootstrap(
  ctx: BootstrapContext,
  deps: RunBootstrapDeps,
): Promise<Envelope> {
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;

  // Initialize (or resume) run-state. initRunState never clobbers an existing
  // run, so a resumed bootstrap keeps the same run id (== install-id tag).
  const state = initRunState({
    phase: 3,
    mode: ctx.mode,
    account: ctx.account,
    region: ctx.region,
    qualifier: ctx.qualifier,
    cwd,
  });
  setMode(ctx.mode, cwd);
  setPhase(3, cwd);

  // (a) HARD BLOCK on a not-empty / unsupported account. No override.
  const guard = buildPreflightGuardChecks(deps.scan, deps.profile);
  if (!guard.ok) {
    // Mark the run as requiring destroy/repair and stop BEFORE any mutating
    // intent is recorded. Nothing was created, so the safe resume class is
    // 'destroy-required' only if something had been; here it is a clean halt.
    setResumeClass('human-gate', cwd);
    return makeEnvelope({
      command: 'bootstrap',
      checks: guard.checks,
      runId: state.runId,
      account: ctx.account,
      region: ctx.region,
      mode: ctx.mode,
    });
  }

  const checks: Check[] = [...guard.checks];

  // (b) Arm the tripwire FIRST (write-ahead intent recorded inside).
  checks.push(armTripwirePhase(ctx, state, cwd));

  // (c) Toolkit, then state primitives.
  const toolkit = toolkitPhase(ctx, cwd);
  checks.push(toolkit);
  // A foreign-toolkit FAIL stops the create chain: do not record further intent
  // against an account whose toolkit we refuse to trust.
  if (toolkit.status !== 'fail') {
    checks.push(statePrimitivesPhase(ctx, cwd));
    // (d) Scoped deploy role.
    checks.push(scopedRolePhase(ctx, cwd));
  }

  // (e) Credential guard + the assume-role record.
  checks.push(await credentialGuardCheck(env));
  if (toolkit.status !== 'fail') {
    checks.push(assumeScopedRoleCheck(ctx));
  }

  // Set the resume class from the assembled checks. Pending live mutations mean
  // the run is not done; if every check is a clean pass it is safe to resume.
  const anyFail = checks.some((c) => c.status === 'fail');
  const anyPending = checks.some((c) => c.status === 'pending');
  if (anyFail) {
    setResumeClass('destroy-required', cwd);
    setStatus('in-progress', cwd);
  } else if (anyPending) {
    setResumeClass('safe-resume', cwd);
    setStatus('in-progress', cwd);
  } else {
    setResumeClass('safe-resume', cwd);
  }

  return makeEnvelope({
    command: 'bootstrap',
    checks,
    runId: state.runId,
    account: ctx.account,
    region: ctx.region,
    mode: ctx.mode,
  });
}

// ─────────────────────────────────────────────────────────────────────
// CLI entry (guarded; never runs on import)
// ─────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(__filename));

const log = (msg: string): void => {
  // eslint-disable-next-line no-console
  console.log(msg);
};

/**
 * Build the real per-region client factory + account-profile clients for the
 * live scan, reusing the doctor's read-only `aws` CLI adapter (cliClient) so
 * bootstrap never grows the runtime dependency tree. The import is dynamic +
 * lazy so importing this module constructs no client and makes no call.
 */
async function liveScanAndProfile(
  region: string,
): Promise<{ scan: ScanResult; profile: AccountProfileResult }> {
  // The scanner + account-profile both accept the same minimal `{ send }`
  // CLI-shaped adapter. We reuse the doctor's read-only `aws` CLI client
  // (cliClient) so bootstrap never grows the runtime dependency tree.
  const { cliClient } = await import('./lib/preflight/checks.js');
  const scan = await runIsolationScan({
    clientFor: (service, scanRegion) =>
      cliClient(service, scanRegion === 'global' ? region : scanRegion),
    regionForEnum: region,
  });
  const profile = await detectAccountProfile({
    organizations: cliClient('organizations', region),
    controlTower: cliClient('controltower', region),
  });
  return { scan, profile };
}

/**
 * The CLI body. Resolves the env + context, RE-RUNS the live scan + profile,
 * then assembles the bootstrap envelope (hard-blocking on a non-empty /
 * unsupported account before any mutating intent). Prints the typed envelope
 * (human, or JSON with --json). Returns the process exit code (non-zero whenever
 * the envelope is not-ok, i.e. any fail or any pending live mutation).
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const jsonMode = argv.includes('--json');
  const envFlag = resolveEnvFlag(argv);
  const envPath = join(repoRoot, envFileNameFor(envFlag));

  if (!existsSync(envPath)) {
    const message =
      `No env file at ${envPath}. ` +
      (envFlag === 'prod'
        ? 'Run `npm run setup` first.'
        : 'Create it by copying .env.staging.example or following docs/staging.md.');
    log(fail(message));
    return 1;
  }

  const env = parseEnvFile(readFileSync(envPath, 'utf-8'));
  let ctx: BootstrapContext;
  try {
    ctx = resolveBootstrapContext(env);
  } catch (err) {
    log(fail(err instanceof Error ? err.message : String(err)));
    return 1;
  }

  // (a) RE-RUN the live isolation scan + account-profile detection.
  const { scan, profile } = await liveScanAndProfile(ctx.region);

  const envelope = await runBootstrap(ctx, { scan, profile, env: process.env, cwd: repoRoot });
  printEnvelope(envelope, { json: jsonMode, log });
  return envelope.ok ? 0 : 1;
}

// Execute only when invoked directly (tsx scripts/bootstrap.ts), never on import.
// Compare resolved paths, not `file://` URLs: import.meta.url percent-encodes
// (e.g. a space in the install path), so the old string compare silently
// no-oped the CLI on any path with a space or on Windows.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === __filename) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(
        fail(`fatal error during bootstrap: ${err instanceof Error ? err.message : String(err)}`),
      );
      process.exit(1);
    });
}
