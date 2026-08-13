#!/usr/bin/env node
/**
 * Builds docs/diagrams/system-walkthrough.excalidraw as a strict
 * top-to-bottom flowchart with NO diagonal arrows. Each card has:
 *
 *   Friendly name + emoji   (big, top)
 *   Real AWS service        (mono subtitle, middle)
 *   One-line role           (bottom)
 *
 * Goal: a non-technical reader can follow the flow by reading the
 * friendly names; a technical reader can map each name back to the
 * exact AWS service.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, 'system-walkthrough.excalidraw');

let _id = 1;
const nextId = () => `el-${(_id++).toString(36)}`;
const seed = () => Math.floor(Math.random() * 1e9);
const now = () => Date.now();
const elements = [];

const base = () => ({
  isDeleted: false,
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roughness: 1,
  opacity: 100,
  angle: 0,
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  groupIds: [],
  frameId: null,
  roundness: null,
  boundElements: [],
  updated: now(),
  link: null,
  locked: false,
  seed: seed(),
  version: 1,
  versionNonce: seed(),
});

function rect({ x, y, w, h, fill = '#fff', stroke = '#1e1e1e', rounded = true, sw = 2 }) {
  const id = nextId();
  elements.push({
    ...base(),
    type: 'rectangle', id,
    x, y, width: w, height: h,
    strokeColor: stroke, backgroundColor: fill,
    fillStyle: 'solid', strokeWidth: sw,
    roundness: rounded ? { type: 3 } : null,
    boundElements: [],
  });
  return id;
}

function text({ x, y, w, h, str, size = 16, color = '#1e1e1e', containerId = null, align = 'center', valign = 'middle', font = 5 }) {
  const id = nextId();
  elements.push({
    ...base(),
    type: 'text', id,
    x, y, width: w, height: h,
    strokeColor: color, backgroundColor: 'transparent',
    fillStyle: 'solid',
    text: str, fontSize: size, fontFamily: font,
    textAlign: align, verticalAlign: valign,
    containerId,
    originalText: str, lineHeight: 1.25, autoResize: true,
    baseline: Math.round(size * 0.85),
  });
  if (containerId) {
    const c = elements.find((e) => e.id === containerId);
    if (c) c.boundElements.push({ id, type: 'text' });
  }
  return id;
}

/**
 * Three-line card. Title (friendly name + emoji), subtitle (the actual
 * AWS service / file path / table name in code font), body (role).
 */
function card({ x, y, w = 320, h = 130, name, aws, role, fill = '#ffffff', stroke = '#1e1e1e' }) {
  const id = rect({ x, y, w, h, fill, stroke });
  text({
    x: x + 8, y: y + 8, w: w - 16, h: 28,
    str: name, size: 18, font: 5, align: 'center', valign: 'top',
  });
  text({
    x: x + 8, y: y + 36, w: w - 16, h: 20,
    str: aws, size: 11, color: '#5f3dc4', font: 3, align: 'center', valign: 'top',
  });
  text({
    x: x + 10, y: y + 60, w: w - 20, h: h - 68,
    str: role, size: 12, color: '#495057', font: 5,
    align: 'center', valign: 'top',
  });
  return id;
}

function header({ x, y, w, str, size = 24 }) {
  text({
    x, y, w, h: 36, str, size, color: '#1e1e1e', font: 5,
    align: 'left', valign: 'top',
  });
}

function band({ x, y, w, h, fill, stroke = '#dee2e6' }) {
  return rect({ x, y, w, h, fill, stroke, sw: 1 });
}

/**
 * Strictly axis-aligned arrow. orient='down' goes from bottom of
 * `from` to top of `to`; orient='right' goes from right of `from` to
 * left of `to`. NEVER diagonal.
 */
function flow(fromId, toId, opts = {}) {
  const from = elements.find((e) => e.id === fromId);
  const to = elements.find((e) => e.id === toId);
  if (!from || !to) return null;
  const orient = opts.orient ?? 'down';
  let sx, sy, tx, ty;
  if (orient === 'down') {
    sx = from.x + from.width / 2;
    sy = from.y + from.height;
    tx = to.x + to.width / 2;
    ty = to.y;
  } else if (orient === 'right') {
    sx = from.x + from.width;
    sy = from.y + from.height / 2;
    tx = to.x;
    ty = to.y + to.height / 2;
  } else if (orient === 'left') {
    sx = from.x;
    sy = from.y + from.height / 2;
    tx = to.x + to.width;
    ty = to.y + to.height / 2;
  }
  const id = nextId();
  elements.push({
    ...base(),
    type: 'arrow', id,
    x: sx, y: sy,
    width: tx - sx, height: ty - sy,
    strokeColor: opts.color ?? '#1864ab',
    backgroundColor: 'transparent',
    strokeWidth: 2.5,
    strokeStyle: opts.dashed ? 'dashed' : 'solid',
    points: [[0, 0], [tx - sx, ty - sy]],
    lastCommittedPoint: [tx - sx, ty - sy],
    startBinding: { elementId: fromId, focus: 0, gap: 4 },
    endBinding: { elementId: toId, focus: 0, gap: 4 },
    startArrowhead: null, endArrowhead: 'arrow',
    elbowed: false,
  });
  from.boundElements.push({ id, type: 'arrow' });
  to.boundElements.push({ id, type: 'arrow' });
  if (opts.label) {
    const cx = (sx + tx) / 2;
    const cy = (sy + ty) / 2;
    text({
      x: cx - 110, y: cy - 9, w: 220, h: 18,
      str: opts.label, size: 12,
      color: opts.color ?? '#1864ab',
      font: 5, align: 'center', valign: 'middle',
    });
  }
  return id;
}

// ─── colour palette ──────────────────────────────────────────────────
const C = {
  surface: { fill: '#e7f5ff', stroke: '#1864ab' },
  gate:    { fill: '#fff5f5', stroke: '#c92a2a' },
  brain:   { fill: '#fff9db', stroke: '#e67700' },
  library: { fill: '#f3f0ff', stroke: '#5f3dc4' },
  advisor: { fill: '#fef0f6', stroke: '#a61e4d' },
  helper:  { fill: '#ebfbee', stroke: '#2b8a3e' },
  ware:    { fill: '#fff4e6', stroke: '#d9480f' },
  bg:      { fill: '#f8f9fa', stroke: '#868e96' },
};

// Canvas: single vertical column. ~2200 wide so we can fit 6 cards
// side-by-side in each band.
const W = 2200;
let y = 40;

// ─── TITLE ───────────────────────────────────────────────────────────
text({
  x: 40, y, w: W - 80, h: 48,
  str: 'Netzar OS Enterprise · what happens when you say "hi"',
  size: 32, color: '#1e1e1e', font: 5, align: 'center', valign: 'top',
});
y += 56;
text({
  x: 40, y, w: W - 80, h: 24,
  str: 'Every box has a friendly name on top and the real AWS service in purple monospace underneath. Blue arrows show the live request flowing down the page.',
  size: 14, color: '#495057', font: 5, align: 'center', valign: 'top',
});
y += 50;

// helper to lay out N cards in a row, evenly spaced, centered.
function row({ items, cardW, cardH, yTop, color }) {
  const totalW = items.length * cardW + (items.length - 1) * 20;
  const xStart = Math.round((W - totalW) / 2);
  const ids = [];
  items.forEach((it, i) => {
    const xx = xStart + i * (cardW + 20);
    ids.push(card({
      x: xx, y: yTop, w: cardW, h: cardH,
      name: it.name, aws: it.aws, role: it.role,
      fill: '#ffffff', stroke: color.stroke,
    }));
  });
  return ids;
}

// ─── 1. THE VISITOR ───────────────────────────────────────────────────
header({ x: 60, y, w: W - 120, str: '①  You send a message on one of three surfaces' });
y += 44;
const surfaceBand = band({ x: 40, y, w: W - 80, h: 200, fill: C.surface.fill });
y += 14;
const surfaceCards = row({
  yTop: y, cardW: 360, cardH: 160, color: C.surface,
  items: [
    { name: 'Sally  📱', aws: 'src/adapters/slack/  ·  Hono POST /slack/events',
      role: 'Verifies the Slack signing-secret HMAC on every webhook. Translates outbound markdown into mrkdwn.' },
    { name: 'Tom  💬', aws: 'src/adapters/telegram/  ·  POST /tg/<agent>/webhook',
      role: 'Per-agent Telegram bots. Voice in via Transcribe; voice out via Polly. SSE streaming back into the chat.' },
    { name: 'Mira  🖥️', aws: 'src/adapters/dashboard/  ·  /dashboard SPA + /api/*',
      role: 'Mission Control SPA at /dashboard. Bearer-token gated. 12 views + a chat panel for ad-hoc turns.' },
  ],
});
y += 170;

// ─── 2. FRONT DOOR ────────────────────────────────────────────────────
header({ x: 60, y, w: W - 120, str: '②  Through the front door  (every request crosses these in order)' });
y += 44;
band({ x: 40, y, w: W - 80, h: 200, fill: C.gate.fill });
y += 14;
const doorCards = row({
  yTop: y, cardW: 360, cardH: 160, color: C.gate,
  items: [
    { name: 'Eddie  🌐', aws: 'CloudFront distribution (T3 only)',
      role: 'Global edge. Caches /dashboard for 1 h. Injects the X-CloudFront-Origin secret header so Bob will let the request in.' },
    { name: 'Wally  🛡️', aws: 'WAFv2 regional WebACL on the ALB',
      role: 'OWASP top-10 + Known Bad Inputs + Anonymous IP list + 2000-req-per-5-min rate limit per source IP.' },
    { name: 'Bob  🚪', aws: 'ALB HTTPS listener rule (B1)',
      role: 'Default action 403 "origin only". Higher-priority rule forwards to the target group only if the secret header matches.' },
  ],
});
y += 170;

// ─── 3. THE CONDUCTOR ─────────────────────────────────────────────────
header({ x: 60, y, w: W - 120, str: '③  The conductor picks the turn up' });
y += 44;
band({ x: 40, y, w: W - 80, h: 200, fill: C.brain.fill });
y += 14;
const brainCards = row({
  yTop: y, cardW: 600, cardH: 160, color: C.brain,
  items: [
    { name: 'Carla  🎩  · the conductor', aws: 'Fargate (ECS) — claudeclaw-orchestrator task',
      role: '3 tasks min, 20 max at T3, ARM64 / Graviton. Hosts the agent loop: picker → tools registry → audit. Streams back via SSE / chat.postMessage / editMessage.' },
    { name: 'Dex  🕵️', aws: 'X-Ray daemon sidecar  ·  public.ecr.aws/xray/aws-xray-daemon',
      role: 'Same task as Carla. captureAWSv3Client wraps Bedrock + DDB + S3 + Polly + SES clients so every call emits a trace segment.' },
  ],
});
y += 170;

// ─── 4. THE LIBRARY ────────────────────────────────────────────────────
header({ x: 60, y, w: W - 120, str: '④  Carla reads + writes the library  (14 DDB tables, all KMS-encrypted)' });
y += 44;
band({ x: 40, y, w: W - 80, h: 460, fill: C.library.fill });
y += 14;
const libRow1 = row({
  yTop: y, cardW: 260, cardH: 130, color: C.library,
  items: [
    { name: 'Memo  📓', aws: 'claudeclaw-sessions',
      role: 'Recent turns per chat. The short-term context loaded on every turn.' },
    { name: 'Rosa  🌱', aws: 'claudeclaw-memories',
      role: 'Durable memories the user told the bot to remember.' },
    { name: 'Cal  📅', aws: 'claudeclaw-scheduled-tasks',
      role: 'One-shot + recurring reminders. Scheduler tick fires due rows.' },
    { name: 'Tess  📝', aws: 'claudeclaw-audit-log',
      role: 'Append-only. IAM denies UpdateItem + DeleteItem at the role.' },
    { name: 'Ben  🛑', aws: 'claudeclaw-kill-switches',
      role: '40 kill switches. Flip to disable a feature in ~30 s.' },
    { name: 'Hilda  🐝', aws: 'claudeclaw-hive-mind',
      role: 'Cross-agent shared "what did each of you see today" log.' },
  ],
});
y += 145;
const libRow2 = row({
  yTop: y, cardW: 260, cardH: 130, color: C.library,
  items: [
    { name: 'Mick  🎯', aws: 'claudeclaw-mission-tasks',
      role: 'Multi-step missions the model can spawn + check off.' },
    { name: 'Tally  💸', aws: 'claudeclaw-token-usage',
      role: 'Per-turn Bedrock cost ledger. Drives the daily cost cap.' },
    { name: 'Inga  📨', aws: 'claudeclaw-inter-agent-tasks',
      role: 'Agent-to-agent inbox. send_dm + read_inbox tools write here.' },
    { name: 'Chad  ⚙️', aws: 'claudeclaw-chat-config',
      role: 'Per-chat overrides (model, persona, sticky agent).' },
    { name: 'Lou  🔁', aws: 'claudeclaw-queue-lease',
      role: 'Conditional-write lease so only one Carla replica processes a row.' },
    { name: '+ 3 more', aws: 'consolidations · agent-file-history · compaction-events',
      role: 'Memory consolidation, edit history, prompt compaction state.' },
  ],
});
y += 170;

// ─── 5. THE WISE ADVISOR ──────────────────────────────────────────────
header({ x: 60, y, w: W - 120, str: '⑤  Carla consults the advisor through a filter' });
y += 44;
band({ x: 40, y, w: W - 80, h: 220, fill: C.advisor.fill });
y += 14;
const advisorCards = row({
  yTop: y, cardW: 540, cardH: 180, color: C.advisor,
  items: [
    { name: 'Phil  🧹  · the filter', aws: 'Bedrock Guardrail  ·  19 PII types + jailbreak',
      role: 'Sits between Carla and Saanvi on BOTH directions. Redacts/blocks: SSN, credit card, phone, email, AWS keys, JWT, IPv4, etc. Plus prompt-injection.' },
    { name: 'Saanvi  🧙  · the advisor', aws: 'Bedrock Converse  ·  us.anthropic.claude-sonnet-4-6',
      role: 'Cross-region inference profile (us-east-1 / east-2 / west-2). Reads context, decides whether to call a tool, streams reply tokens.' },
    { name: 'Bridget  🌉', aws: 'Bedrock cross-region inference  ·  us.* / eu.*',
      role: 'Automatic regional fan-out. Absorbs single-region throttles transparently.' },
  ],
});
y += 200;

// ─── 6. HELPERS ────────────────────────────────────────────────────────
header({ x: 60, y, w: W - 120, str: '⑥  When Saanvi wants to actually do something, she calls a helper  (23 tools registered)' });
y += 44;
band({ x: 40, y, w: W - 80, h: 750, fill: C.helper.fill });
y += 14;

const helperRow1 = row({
  yTop: y, cardW: 260, cardH: 130, color: C.helper,
  items: [
    { name: 'Ada  🎨', aws: 'Bedrock Nova Canvas  ·  generate_image',
      role: 'Text-to-image. PNG to Vinnie. 24 h presigned URL back to the model.' },
    { name: 'Stella  📄', aws: 'pdfkit + docx + exceljs  ·  generate_document',
      role: 'PDF / DOCX / XLSX builder. Output to Vinnie under generations/.' },
    { name: 'Scarlet  🔍', aws: 'Tavily / Brave / Exa / Serper  ·  web_search',
      role: 'Live web. Outbound PII filter (B3) runs before the vendor call.' },
    { name: 'Pete  📬', aws: 'SES v2  ·  send_email',
      role: 'Transactional email. SPF/DKIM via the SES verified identity.' },
    { name: 'Polly  🔊', aws: 'Amazon Polly  ·  synthesize',
      role: 'TTS for voice replies on Telegram. Gated by tts_disabled.' },
    { name: 'Tina  🎙️', aws: 'Amazon Transcribe  ·  transcribeAudio',
      role: 'Voice notes → text. Async; falls back to "I got your file" on timeout.' },
  ],
});
y += 145;
const helperRow2 = row({
  yTop: y, cardW: 260, cardH: 130, color: C.helper,
  items: [
    { name: 'Vex  🧭', aws: 'S3 Vectors  ·  s3_vectors_search',
      role: 'Semantic retrieval over Curated Curt. Cosine ranking, top-K cited.' },
    { name: 'Ingrid  📥', aws: 'Bedrock Titan embed + S3  ·  ingest_document',
      role: 'PDF/HTML/MD → cleaned text → 1024-token chunks → vectors.' },
    { name: 'Doris  🗃️', aws: 'DynamoDB Query  ·  dynamodb_query',
      role: 'Allowlisted SELECT-style queries over named tables only.' },
    { name: 'Maya  🧠', aws: 'add_memory + list_memories + forget_memory',
      role: 'Memory CRUD against Rosa. Each write goes through Phil.' },
    { name: 'Quinn  📨', aws: 'send_dm + read_inbox  ·  Inga inbox',
      role: 'Agent-to-agent messaging. The "missions can talk" primitive.' },
    { name: 'Reggie  ↩️', aws: 'forget_me  ·  purgeChatData',
      role: 'Snapshot + hash + delete all per-chat data. Auditable WORM record in Sealed Sam.' },
  ],
});
y += 145;
const helperRow3 = row({
  yTop: y, cardW: 260, cardH: 130, color: C.helper,
  items: [
    { name: 'Tom-Tock  ⌚', aws: 'get_time',
      role: 'Server-side now() in UTC + the caller\'s zone if known.' },
    { name: 'Marv  📜', aws: 'log_to_hive + search_hive  ·  Hilda hive-mind',
      role: 'Cross-agent shared log + retrieval.' },
    { name: 'Mira-T  🧗', aws: 'create_mission + list/update_mission  ·  Mick',
      role: 'Multi-step missions: bullet-list checkpoints the model can mark done.' },
    { name: 'Cassie  📅', aws: 'schedule_task + list/cancel_scheduled_task',
      role: 'Wraps Cal. Natural-language "in 5 min" → cron / one-shot row.' },
    { name: 'Andie  📂', aws: 'agent_file_edit  ·  Cathy + history table',
      role: 'Edits CLAUDE.md / agent.yaml. Hot-reload via SNS fan-out.' },
    { name: 'Slim  📣', aws: 'list_agents',
      role: 'Tells the model which sibling agents exist this turn.' },
  ],
});
y += 145;
const helperRow4 = row({
  yTop: y, cardW: 260, cardH: 130, color: C.helper,
  items: [
    { name: 'Bert  🔎', aws: 'Bedrock KB retrieve (tier 2+)',
      role: 'Reserved for Phase G. Bedrock KB + OpenSearch when data-lake lights up.' },
    { name: 'Athena  🏛️', aws: 'Athena workgroup (tier 2+)',
      role: 'Reserved for Phase G. Allowlisted SQL over curated S3.' },
    { name: 'Stage Stu Jr  ⏳', aws: 'S3 vectors staging  ·  intake_document',
      role: 'Stage-area pickup for the ingest pipeline.' },
    { name: 'Frodo  🔁', aws: 'forward_message',
      role: '/forward command. Hands control of a turn to a sibling agent.' },
    { name: 'Nessa  🆕', aws: '/newchat command',
      role: 'Wipes only the current chat\'s session row. Memories stay.' },
    { name: 'Mira-M  🤖', aws: '/model command',
      role: 'Per-chat model override (sonnet ↔ haiku ↔ opus).' },
  ],
});
y += 170;

// ─── 7. WAREHOUSE ──────────────────────────────────────────────────────
header({ x: 60, y, w: W - 120, str: '⑦  Helper outputs land in the warehouse  (S3 — 6 buckets, each KMS-encrypted)' });
y += 44;
band({ x: 40, y, w: W - 80, h: 200, fill: C.ware.fill });
y += 14;
const wareCards = row({
  yTop: y, cardW: 320, cardH: 160, color: C.ware,
  items: [
    { name: 'Vinnie  📦', aws: 'claudeclaw-raw',
      role: 'Generated PDFs, images, voice notes, uploaded docs. Presigned URLs valid 24 h.' },
    { name: 'Annie  🗄️', aws: 'claudeclaw-logs  ·  Glacier @ 90 days',
      role: 'CloudTrail + VPC flow + ALB access + ddb-exports/. Lifecycle to Glacier.' },
    { name: 'Sealed Sam  🔒', aws: 'claudeclaw-audit-lock  ·  S3 Object Lock',
      role: 'Write-once-read-many. 7-year governance retention. Even root cannot delete.' },
    { name: 'Cathy  📁', aws: 'claudeclaw-config',
      role: 'agents/*/CLAUDE.md + agent.yaml + addons.yaml. SNS notifies on changes.' },
    { name: 'Curated Curt  📚', aws: 'claudeclaw-curated',
      role: 'Cleaned documents + S3 Vectors index ready for retrieval.' },
    { name: 'Stage Stu  ⏳', aws: 'claudeclaw-vectors-staging',
      role: 'Ingest staging. Chunks live here until embedded + moved to Curt.' },
  ],
});
y += 180;

// ─── 8. REPLY ──────────────────────────────────────────────────────────
header({ x: 60, y, w: W - 120, str: '⑧  Reply goes back the same way' });
y += 44;
band({ x: 40, y, w: W - 80, h: 100, fill: '#e7f5ff' });
text({
  x: 60, y: y + 30, w: W - 120, h: 50,
  str:
    'Carla appends the assistant turn to Memo, writes an audit row to Tess (+ S3-lock copy via Sealed Sam), and posts the reply through the SAME surface (Sally / Tom / Mira) the request came in on.',
  size: 16, color: '#1864ab', font: 5, align: 'center', valign: 'middle',
});
y += 130;

// ─── 9. BACKGROUND CREW (LEFT-RIGHT GRID, NO ARROWS) ──────────────────
header({ x: 60, y, w: W - 120, str: 'Always running, never on the request path' });
y += 44;
band({ x: 40, y, w: W - 80, h: 590, fill: C.bg.fill });
y += 14;
const bgRow1 = row({
  yTop: y, cardW: 320, cardH: 160, color: C.bg,
  items: [
    { name: 'Beth  ⏰', aws: 'Lambda · claudeclaw-ddb-export  ·  A4',
      role: 'Daily at 02:00 UTC. Iterates every DDB table; calls ExportTableToPointInTime → Annie under ddb-exports/<table>/<date>/.' },
    { name: 'Winnie  👀', aws: 'CloudWatch alarms + Mission Control dashboard',
      role: '7 alarms wired to the ops SNS topic. Cost-per-turn, scheduler-stalled, canary, error rate, bedrock throttle, kill-switch trip.' },
    { name: 'Sentry Sam  👮', aws: 'GuardDuty  ·  B2',
      role: 'Continuous threat detection. 15-min finding-publish frequency. Findings → ops SNS.' },
    { name: 'Luca  🔑', aws: 'KMS  ·  3 customer-managed keys',
      role: 'data / curated / logs CMKs. Everything at rest, including DDB rows and S3 objects, encrypted under one of these.' },
    { name: 'Victor  🗝️', aws: 'Secrets Manager  ·  5 secrets',
      role: '/claudeclaw/{slack,telegram,dashboard,db-encryption,bedrock-guardrails}. Injected as task-def env at boot.' },
  ],
});
y += 175;
const bgRow2 = row({
  yTop: y, cardW: 320, cardH: 160, color: C.bg,
  items: [
    { name: 'Dave  🚀', aws: 'GitHub Actions OIDC  ·  ClaudeClawGitHubDeploy role  ·  A2',
      role: 'Build linux/arm64 via buildx + QEMU. cdk deploy --all. force-new-deployment. Manual dispatch + typed "deploy" confirm.' },
    { name: 'Coco  🐦', aws: 'Synthetic canary  ·  src/agent/canary.ts',
      role: 'Drives a test turn every 5 min from inside the orchestrator. Two failures in a row → ops page.' },
    { name: 'Casey  💰', aws: 'getDailyCostUsd + cost_cap_per_day kill switch',
      role: 'Reads Tally between turns. Trips the kill switch when daily Bedrock spend > CCE_DAILY_COST_CAP_USD.' },
    { name: 'Hattie  ♻️', aws: 'SNS  ·  claudeclaw-config-invalidation',
      role: 'Cathy publishes here on every PutObject. SQS fan-out → every Carla replica reloads its in-memory cache within 5 min.' },
    { name: 'Calendar Cal  📆', aws: 'src/agent/scheduler.ts in-process tick',
      role: 'Polls Cal every 30 s. Conditional-write claim via Lou so only one replica fires a given task row.' },
  ],
});
y += 175;
const bgRow3 = row({
  yTop: y, cardW: 320, cardH: 160, color: C.bg,
  items: [
    { name: 'Conrad  📋', aws: 'AWS Config (B2 — gated CCE_CONFIG_ENABLED=1)',
      role: 'Continuous compliance recording. 15 managed rules: public-S3, IAM-root keys, KMS rotation, CloudTrail-on, encrypted-volumes, etc.' },
    { name: 'Ratel Ronnie  ⚡', aws: 'WAFv2 rate-based rule  ·  Wally',
      role: '2000 requests per 5-min sliding window per source IP. Drops at the WAF before reaching the ALB.' },
    { name: 'Cloudie  🌥️', aws: 'CloudTrail  ·  claudeclaw-audit trail',
      role: 'All-region read+write management events to Annie. File-integrity validation on.' },
    { name: 'Flo  🌊', aws: 'VPC Flow Logs  ·  S3 destination',
      role: 'Every accepted/rejected packet logged to Annie under vpc-flow-logs/. Glacier at 90 days.' },
    { name: 'Helga  📜', aws: 'docs/runbooks/  ·  D4',
      role: '10 runbooks: deploy-validation, rotate-tokens, restore-ddb, kill-switches, debug-no-slack-response, scale-up, rollback-bad-image.' },
  ],
});
y += 175;

// ─── ARROWS (axis-aligned only) ───────────────────────────────────────
// Surfaces (3) → matching door cards (Eddie, Wally, Bob) would crowd —
// instead all three feed into Eddie (in real life, CloudFront is the
// single entry point for T3 apex traffic).
flow(surfaceCards[0], doorCards[0], { label: 'POST /slack/events' });
flow(surfaceCards[1], doorCards[0], { label: 'POST /tg/.../webhook' });
flow(surfaceCards[2], doorCards[0], { label: 'GET /api/*  +  /dashboard' });

// Eddie → Wally → Bob horizontally
flow(doorCards[0], doorCards[1], { orient: 'right' });
flow(doorCards[1], doorCards[2], { orient: 'right' });

// Bob → Carla
flow(doorCards[2], brainCards[0], { label: 'X-CloudFront-Origin: <secret>' });

// Carla → library (Memo is the most-touched table — load context)
flow(brainCards[0], libRow1[0], { label: 'getSession on every turn' });

// Carla → advisor (Phil first; he gates the call to Saanvi)
flow(brainCards[0], advisorCards[0], { label: 'prompt + tool catalog' });

// Phil → Saanvi (horizontal within the advisor band)
flow(advisorCards[0], advisorCards[1], { orient: 'right', label: 'cleaned' });

// Saanvi → first helper (one arrow; the registry actually picks per call)
flow(advisorCards[1], helperRow1[0], { label: 'tool call (when needed)' });

// Helpers → warehouse (one representative arrow — every tool that
// produces bytes writes to Vinnie or Curt; the audit row in Tess
// records WHICH one)
flow(helperRow1[1], wareCards[0], { label: 'store output' });

// ─── WRITE ────────────────────────────────────────────────────────────
const doc = {
  type: 'excalidraw',
  version: 2,
  source: 'claudeclaw-enterprise/docs/diagrams/build-walkthrough.mjs',
  elements,
  appState: { gridSize: null, viewBackgroundColor: '#fafafa' },
  files: {},
};
writeFileSync(OUT, JSON.stringify(doc, null, 2));
// eslint-disable-next-line no-console
console.log(`wrote ${elements.length} elements → ${OUT}`);
