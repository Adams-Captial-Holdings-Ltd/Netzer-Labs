/** Frozen acceptance tests for the pack format schemas (Work Platform step 3, gate s3-proof). */
import { describe, expect, it } from 'vitest';
import { agentDefinitionSchema, configSchemaSchema, packManifestSchema } from './schema.js';

const agent = { id: 'intake', name: 'Intake', description: 'd', model: 'm', persona: 'p' };

describe('pack format schemas', () => {
  it('S3-C10 customerEditable and controlsApproval default to false', () => {
    const schema = configSchemaSchema.parse({ type: 'object', properties: { hours: { type: 'number' } } });
    expect(schema.properties.hours).toMatchObject({ customerEditable: false, controlsApproval: false });
    expect(schema.required).toEqual([]);
  });
  it('S3-C11 the agent format needs id, name, description, model and persona; the rest is optional', () => {
    expect(agentDefinitionSchema.parse(agent)).toMatchObject(agent);
    for (const key of Object.keys(agent)) {
      const { [key as keyof typeof agent]: _omit, ...rest } = agent;
      expect(agentDefinitionSchema.safeParse(rest).success).toBe(false);
    }
    expect(agentDefinitionSchema.safeParse({ ...agent, tools: ['a'], skills: ['skills/a.md'], knowledgeScope: 's' }).success).toBe(true);
  });
  it('S3-C11 the agent format rejects unknown keys', () => {
    expect(agentDefinitionSchema.safeParse({ ...agent, temperature: 1 }).success).toBe(false);
  });
  it('S3-C02 a manifest without packFormat is rejected', () => {
    expect(packManifestSchema.safeParse({ id: 'x' }).success).toBe(false);
  });
});
