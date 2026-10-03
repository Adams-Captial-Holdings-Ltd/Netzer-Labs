/**
 * Salesforce tools (SOQL query + record CRUD) over the OAuth connection the
 * Integrations Connect button lands in runtime-config.
 *
 * Registered unconditionally (the requirement is CONNECTION state, not an
 * env var, so registerIfConfigured would never fire) and gated at invoke
 * time on (a) the salesforce_disabled kill switch and (b) the presence of
 * oauth/salesforce_tokens — with a clean "not connected" message otherwise.
 */

import type { Tool as BedrockTool } from '@aws-sdk/client-bedrock-runtime';
import { tools } from './registry.js';
import { registerAddon } from '../addons/registry.js';
import { isKillSwitchActive } from '../state/kill-switches-repo.js';
import { writeAudit } from '../audit/audit-writer.js';
import {
  sfQuery,
  sfRequest,
  sobjectPath,
  SalesforceAuthError,
  SalesforceNotConnectedError,
} from '../salesforce/client.js';

function spec(name: string, description: string, schema: unknown): BedrockTool {
  return {
    toolSpec: {
      name,
      description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputSchema: { json: schema as any },
    },
  };
}

registerAddon({
  id: 'salesforce',
  title: 'Salesforce (SOQL + records)',
  category: 'integration',
  description: 'Query and update Salesforce records from any chat surface.',
  required: [
    { description: 'Salesforce OAuth connection (Integrations → Connect Salesforce)' },
  ],
  killSwitch: 'salesforce_disabled',
  defaultOn: true,
});

async function gate(): Promise<string | null> {
  const killed = await isKillSwitchActive('salesforce_disabled');
  if (killed.active) {
    return `Salesforce tools are disabled: ${killed.reason ?? 'kill switch active'}`;
  }
  return null;
}

function friendly(err: unknown): string {
  if (err instanceof SalesforceNotConnectedError || err instanceof SalesforceAuthError) {
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Compact line-per-record rendering, bounded for the model. */
function renderRecords(records: Record<string, unknown>[], cap = 4000): string {
  const lines = records.map((r) => {
    const entries = Object.entries(r)
      .filter(([k]) => k !== 'attributes')
      .slice(0, 8)
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
    return `- ${entries.join(' | ')}`;
  });
  let out = lines.join('\n');
  if (out.length > cap) out = `${out.slice(0, cap)}\n… (truncated)`;
  return out;
}

tools.register('salesforce_query', {
  readOnly: true,
  spec: spec(
    'salesforce_query',
    'Run a read-only SOQL query against the connected Salesforce org. Use for questions about accounts, contacts, opportunities, leads, or any object ("how many open opportunities over $50k?").',
    {
      type: 'object',
      required: ['soql'],
      properties: {
        soql: {
          type: 'string',
          description: 'The SOQL query, e.g. "SELECT Id, Name, Amount FROM Opportunity WHERE IsClosed = false LIMIT 20". Always include a LIMIT.',
        },
      },
    },
  ),
  async invoke(args) {
    const blocked = await gate();
    if (blocked) return { text: blocked, isError: true };
    const soql = String(args.soql ?? '').trim();
    if (!soql) return { text: 'soql is required', isError: true };
    if (!/^select\s/i.test(soql)) {
      return { text: 'salesforce_query is read-only — the SOQL must start with SELECT.', isError: true };
    }
    try {
      const out = await sfQuery(soql);
      if (out.records.length === 0) return { text: `0 of ${out.totalSize} records.` };
      return {
        text: `${out.records.length} of ${out.totalSize} records:\n${renderRecords(out.records)}`,
      };
    } catch (err) {
      return { text: `Salesforce query failed: ${friendly(err)}`, isError: true };
    }
  },
});

tools.register('salesforce_record', {
  spec: spec(
    'salesforce_record',
    'Get, create, update, or delete a single Salesforce record. Use salesforce_query for searches; this is for direct record operations once you know the object (and id for get/update/delete).',
    {
      type: 'object',
      required: ['action', 'object'],
      properties: {
        action: { type: 'string', enum: ['get', 'create', 'update', 'delete'] },
        object: { type: 'string', description: 'API name, e.g. "Contact", "Opportunity", "My_Object__c".' },
        id: { type: 'string', description: 'Record id (required for get/update/delete).' },
        fields: {
          type: 'object',
          description: 'Field map for create/update, e.g. {"LastName":"Example","Email":"user@example.com"}.',
        },
      },
    },
  ),
  async invoke(args, ctx) {
    const blocked = await gate();
    if (blocked) return { text: blocked, isError: true };
    const action = String(args.action ?? '');
    const object = String(args.object ?? '').trim();
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    const fields = (args.fields ?? {}) as Record<string, unknown>;
    if (!object) return { text: 'object is required', isError: true };
    if ((action === 'get' || action === 'update' || action === 'delete') && !id) {
      return { text: `id is required for ${action}`, isError: true };
    }
    try {
      let text: string;
      if (action === 'get') {
        const rec = (await sfRequest({ method: 'GET', path: sobjectPath(object, id) })) as Record<string, unknown>;
        text = renderRecords([rec]);
      } else if (action === 'create') {
        const out = (await sfRequest({ method: 'POST', path: sobjectPath(object), body: fields })) as { id?: string };
        text = `Created ${object} ${out.id ?? ''}.`;
      } else if (action === 'update') {
        await sfRequest({ method: 'PATCH', path: sobjectPath(object, id), body: fields });
        text = `Updated ${object} ${id}.`;
      } else if (action === 'delete') {
        await sfRequest({ method: 'DELETE', path: sobjectPath(object, id) });
        text = `Deleted ${object} ${id}.`;
      } else {
        return { text: `Unknown action ${action}`, isError: true };
      }
      // Mutations leave an audit trail (reads ride the normal tool metric).
      if (action !== 'get') {
        void writeAudit({
          action: 'tool_invoke',
          agentId: ctx.agentId,
          chatId: ctx.chatId,
          toolName: 'salesforce_record',
          detail: { action, object, id: id || null },
          result: 'ok',
        });
      }
      return { text };
    } catch (err) {
      return { text: `Salesforce ${action} failed: ${friendly(err)}`, isError: true };
    }
  },
});
