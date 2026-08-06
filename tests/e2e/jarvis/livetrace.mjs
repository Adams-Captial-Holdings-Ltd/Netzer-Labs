import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
const TABLE = 'claudeclaw-audit-log';
const start = new Date(Date.now() - 5000).toISOString();
const seen = new Set();
const END = Date.now() + 7 * 60 * 1000;
console.log(`LIVE TRACE — watching from ${start}. Talk to Jarvis now (window ~7 min).`);
function line(r) {
  const t = String(r.ts || '').slice(11, 19);
  const a = r.action || '';
  const d = r.detail || {};
  if (a === 'jarvis_session_start') return `[${t}] ════ SESSION START (${d.mode || ''}) ════`;
  if (a === 'jarvis_session_end') return `[${t}] ════ SESSION END (${d.reason || ''}) ════`;
  if (a === 'jarvis_navigate') return `[${t}] NAVIGATE → ${d.route}${d.allowed === false ? ' (BLOCKED)' : ''}${d.rawRoute && d.rawRoute !== d.route ? `   [heard: "${d.rawRoute}"]` : ''}`;
  if (a === 'jarvis_query') return `[${t}] QUERY ${d.resource}`;
  if (a === 'jarvis_voice_turn') return `[${t}] JARVIS: ${d.responseSummary}`;
  return `[${t}] ${a} ${JSON.stringify(d).slice(0, 140)}`;
}
async function poll() {
  const out = await ddb.send(new ScanCommand({
    TableName: TABLE,
    FilterExpression: 'begins_with(#a, :j) AND #t >= :s',
    ExpressionAttributeNames: { '#a': 'action', '#t': 'ts' },
    ExpressionAttributeValues: { ':j': 'jarvis', ':s': start },
  }));
  const rows = (out.Items || [])
    .map((r) => ({ r, k: `${r.ts}|${r.action}|${(r.detail && (r.detail.responseSummary || r.detail.route || r.detail.reason)) || ''}` }))
    .filter((x) => !seen.has(x.k))
    .sort((a, b) => (a.r.ts > b.r.ts ? 1 : -1));
  for (const { r, k } of rows) { seen.add(k); console.log(line(r)); }
}
while (Date.now() < END) {
  try { await poll(); } catch (e) { console.log('(poll error:', e.message + ')'); }
  await new Promise((r) => setTimeout(r, 3000));
}
console.log('LIVE TRACE ended.');
