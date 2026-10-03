import { describe, expect, it } from 'vitest';
import { tools } from './registry.js';
import './builtin-tools.js';
import './memory-tools.js';
import './schedule-tools.js';
import './agent-tools.js';
import './vector-tools.js';
import './dynamodb-tools.js';
import './mission-tools.js';
import './nova-canvas-tools.js';
import './email-tools.js';
import './web-search-tools.js';
import './privacy-tools.js';
import './document-generation-tools.js';
import './document-draft-tools.js';
import './identity-tools.js';
import './salesforce-tools.js';
import './paperclip-tools.js';
import './artifact-read-tools.js';

const neverReadOnly = ['paperclip_add_comment', 'paperclip_create_subtask', 'create_mission', 'update_mission',
  'send_dm', 'send_email', 'salesforce_record', 'schedule_task', 'cancel_scheduled_task', 'add_memory',
  'forget_memory', 'forget_me', 'generate_document', 'generate_image', 'document_draft', 'ingest_document',
  'log_to_hive', 'ask_agent', 'start_identity_claim', 'complete_identity_claim', 'read_inbox'];

describe('real registered tool marks', () => {
  it('marks only the ten verified readers', () => {
    expect(tools.isReadOnly('no_such_tool')).toBe(false);
    const names = tools.listFor('main').map((entry) => entry.toolSpec?.name).filter((name): name is string => !!name);
    expect(names.filter((name) => tools.isReadOnly(name)).sort()).toEqual([
      'dynamodb_query', 'get_time', 'list_agents', 'list_memories', 'list_missions',
      'list_scheduled_tasks', 's3_vectors_search', 'salesforce_query', 'search_hive', 'search_memories',
    ]);
    for (const name of neverReadOnly) expect(tools.isReadOnly(name), name).toBe(false);
  });
});
