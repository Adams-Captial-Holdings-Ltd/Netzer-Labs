/** Frozen acceptance test: the built-in templates use the one agent format (Work Platform step 3, S3-C11). */
import { describe, expect, it } from 'vitest';
import { listTemplates, templateAgentDefinition } from './templates.js';
import { agentDefinitionSchema } from '../packs/schema.js';

describe('agent templates in the canonical agent format', () => {
  it('S3-C11 every built-in template yields a valid agent definition', () => {
    const all = listTemplates();
    expect(all.length).toBe(17);
    for (const t of all) {
      const def = templateAgentDefinition(t);
      expect(agentDefinitionSchema.safeParse(def).success).toBe(true);
      expect(def.id).toBe(t.id);
      expect(def.name).toBe(t.displayName);
      expect(def.description).toBe(t.description);
      expect(def.persona).toBe(t.buildClaudeMd());
      expect(def.model).toBe(t.suggestedModel ?? def.model);
      expect(def.model.length).toBeGreaterThan(0);
      if (t.suggestedKnowledgeScope) expect(def.knowledgeScope).toBe(t.suggestedKnowledgeScope);
    }
  });
});
