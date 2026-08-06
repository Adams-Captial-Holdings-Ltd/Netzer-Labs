import { describe, it, expect } from 'vitest';
import { listTemplates, getTemplate } from './templates.js';

describe('agent templates', () => {
  it('ships the full gallery (5 general + 12 vertical)', () => {
    const all = listTemplates();
    expect(all.length).toBe(17);
    const ids = all.map((t) => t.id);
    for (const id of [
      'blank', 'comms', 'content', 'ops', 'research',
      'due-diligence', 'lp-update', 'deal-memo',
      'grant-writer', 'compliance-reviewer', 'exec-assistant',
      'support', 'sdr', 'social', 'marketing-strategist',
      'community-manager', 'bookkeeper',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('every template has complete gallery metadata and a substantial prompt', () => {
    for (const t of listTemplates()) {
      expect(t.tagline.length).toBeGreaterThan(0);
      expect(t.icon.length).toBeGreaterThan(0);
      expect(['general', 'finance', 'nonprofit', 'business']).toContain(t.category);
      const prompt = t.buildClaudeMd();
      expect(prompt.length).toBeGreaterThan(500);
      // Every prompt ends with the shared rules floor.
      expect(prompt).toContain('# Memory and recall');
      expect(prompt).toContain('# Safety and trust');
    }
  });

  it('builds the date lazily (creation time, not module-load time)', () => {
    const prompt = getTemplate('blank')!.buildClaudeMd();
    expect(prompt).toContain(`Today is ${new Date().toISOString().slice(0, 10)}`);
  });

  it('vertical templates carry their knowledge-scope suggestions', () => {
    expect(getTemplate('due-diligence')!.suggestedKnowledgeScope).toBe('deals');
    expect(getTemplate('grant-writer')!.suggestedKnowledgeScope).toBe('grants');
    expect(getTemplate('compliance-reviewer')!.suggestedKnowledgeScope).toBe('policies');
  });

  it('vertical prompts ground in the knowledge base', () => {
    for (const id of ['due-diligence', 'deal-memo', 'compliance-reviewer']) {
      expect(getTemplate(id)!.buildClaudeMd()).toContain('s3_vectors_search');
    }
  });
});
