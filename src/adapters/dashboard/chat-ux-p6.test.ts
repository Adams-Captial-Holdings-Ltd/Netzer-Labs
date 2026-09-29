/**
 * P6 (step 8) — the chat page's DOM-free helpers, run by the root vitest.
 *
 * Written BEFORE the change, as the bar (netzar-chat-plan/p6-proof.sh rows W-1..W-4). Each
 * module is loaded lazily so a module that does not exist yet fails its own test with a
 * plain assertion instead of failing the whole file at import.
 *
 *   - export.ts: the whole conversation as ONE Markdown file, built in the page from the
 *     messages it already holds (the P6 council's markdown_client): a title heading, then
 *     every turn in order under its speaker, with the files it carried and the files the
 *     reply made named, and a stopped reply marked; a safe file name from the title.
 *   - export.ts also names a code block's download for its language. It lives here, not in
 *     code-block.ts, because this file must stay DOM-free: code-block.ts imports highlight.js,
 *     whose types pull the DOM library into the ROOT type program and break Node's fetch types.
 *   - drafts.ts: an unsent draft is kept per conversation in TAB storage (sessionStorage,
 *     the council's session_storage: gone when the tab closes), and cleared on send.
 *   - model-label.ts: the model picker's trigger reads the model's family and its context
 *     size (decision 36 and the council's restyle_only: no capability badges).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Message } from '../../../web/src/lib/chat/types.js';

type ExportModule = {
  conversationMarkdown: (c: { title: string; agentName: string; messages: Message[] }) => string;
  exportFileName: (title: string) => string;
};
type CodeModule = { codeFileName: (language: string) => string };
type DraftsModule = {
  loadDraft: (agentId: string, chatId: string, storage?: Storage) => string;
  saveDraft: (agentId: string, chatId: string, text: string, storage?: Storage) => void;
  clearDraft: (agentId: string, chatId: string, storage?: Storage) => void;
};
type ModelLabelModule = {
  modelTriggerParts: (m: { label: string; id: string; contextWindow: number; family: string; isDefault: boolean }) => {
    family: string;
    context: string;
  };
};


/** A Storage stand-in with the real interface. */
function memoryStorage(): Storage & { dump: () => Record<string, string> } {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    key: (i: number) => [...data.keys()][i] ?? null,
    removeItem: (k: string) => { data.delete(k); },
    setItem: (k: string, v: string) => { data.set(k, String(v)); },
    dump: () => Object.fromEntries(data),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('P6 chat page helpers', () => {
  it('P6 the conversation export is Markdown with every turn in order', async () => {
    const mod = (await import('../../../web/src/lib/chat/export.js').catch(() => null)) as ExportModule | null;
    expect(mod, 'web/src/lib/chat/export.ts exports conversationMarkdown and exportFileName').not.toBeNull();
    const messages: Message[] = [
      { role: 'user', text: 'Summarise the Q3 plan', ts: 1_758_970_000, attachments: [{ id: 'a', name: 'q3-plan.pdf', type: 'application/pdf', size: 10 }] },
      {
        role: 'assistant', text: 'Here is the summary.\n\n| Region | Status |\n|---|---|\n| EU | green |', ts: 1_758_970_010,
        artifactRefs: [{ artifactId: '11111111-1111-4111-8111-111111111111', version: 1, fileName: 'summary.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', createdAt: '2026-09-27T10:00:00.000Z' }],
      },
      { role: 'user', text: 'Shorter please', ts: 1_758_970_020 },
      { role: 'assistant', text: 'Q3 is on track', ts: 1_758_970_030, stopped: true },
    ];
    const md = mod!.conversationMarkdown({ title: 'Q3 plan review', agentName: 'Netzar Prime', messages });

    expect(md.startsWith('# Q3 plan review')).toBe(true);
    // Every turn, in order, under its speaker.
    const order = ['Summarise the Q3 plan', 'Here is the summary.', 'Shorter please', 'Q3 is on track'].map((t) => md.indexOf(t));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(md.split('Netzar Prime').length - 1).toBeGreaterThanOrEqual(2);
    expect(md).toMatch(/\bYou\b/);
    // The reply's own Markdown survives as Markdown (a table stays a table).
    expect(md).toContain('| Region | Status |');
    // Files are named, never linked: the export carries no storage address.
    expect(md).toContain('q3-plan.pdf');
    expect(md).toContain('summary.docx');
    expect(md).not.toMatch(/https?:\/\/|s3:\/\/|X-Amz-/);
    // A stopped reply says so.
    expect(md.slice(md.indexOf('Q3 is on track'))).toMatch(/stopped/i);

    // The file name is the title made safe, as Markdown.
    expect(mod!.exportFileName('Q3 plan: review / final?')).toMatch(/^[A-Za-z0-9 ._-]+\.md$/);
    expect(mod!.exportFileName('Q3 plan: review / final?')).toContain('Q3 plan');
    expect(mod!.exportFileName('')).toMatch(/\.md$/);
  });

  it('P6 a code download is named for its language', async () => {
    const mod = (await import('../../../web/src/lib/chat/export.js').catch(() => null)) as CodeModule | null;
    expect(typeof mod?.codeFileName, 'export.ts exports codeFileName').toBe('function');
    const name = mod!.codeFileName;
    expect(name('typescript')).toBe('snippet.ts');
    expect(name('ts')).toBe('snippet.ts');
    expect(name('python')).toBe('snippet.py');
    expect(name('bash')).toBe('snippet.sh');
    expect(name('json')).toBe('snippet.json');
    expect(name('html')).toBe('snippet.html');
    expect(name('sql')).toBe('snippet.sql');
    // An unknown or missing language is still a safe plain-text file.
    expect(name('code')).toBe('snippet.txt');
    expect(name('')).toBe('snippet.txt');
    expect(name('../../etc/passwd')).toBe('snippet.txt');
  });

  it('P6 drafts are kept per conversation in tab storage and cleared on send', async () => {
    const mod = (await import('../../../web/src/lib/chat/drafts.js').catch(() => null)) as DraftsModule | null;
    expect(mod, 'web/src/lib/chat/drafts.ts exports loadDraft, saveDraft and clearDraft').not.toBeNull();
    const tab = memoryStorage();
    const lasting = memoryStorage();
    vi.stubGlobal('sessionStorage', tab);
    vi.stubGlobal('localStorage', lasting);

    // Per conversation: two drafts side by side, each read back alone.
    mod!.saveDraft('main', 'dashboard:1', 'first draft');
    mod!.saveDraft('main', 'dashboard:2', 'second draft');
    expect(mod!.loadDraft('main', 'dashboard:1')).toBe('first draft');
    expect(mod!.loadDraft('main', 'dashboard:2')).toBe('second draft');
    expect(mod!.loadDraft('other-agent', 'dashboard:1')).toBe('');

    // In TAB storage by default, never in storage that outlives the tab.
    expect(JSON.stringify(tab.dump())).toContain('first draft');
    expect(JSON.stringify(tab.dump())).toContain('second draft');
    expect(lasting.dump()).toEqual({});

    // Sending clears it; an emptied draft leaves nothing behind.
    mod!.clearDraft('main', 'dashboard:1');
    expect(mod!.loadDraft('main', 'dashboard:1')).toBe('');
    mod!.saveDraft('main', 'dashboard:2', '');
    expect(tab.dump()).toEqual({});

    // Storage that throws (a private window, blocked site data) never breaks the page.
    const broken = {
      ...memoryStorage(),
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    } as unknown as Storage;
    expect(() => mod!.saveDraft('main', 'dashboard:3', 'x', broken)).not.toThrow();
    expect(mod!.loadDraft('main', 'dashboard:3', broken)).toBe('');
  });

  it('P6 the model trigger reads the family and the context size', async () => {
    const mod = (await import('../../../web/src/lib/chat/model-label.js').catch(() => null)) as ModelLabelModule | null;
    expect(typeof mod?.modelTriggerParts, 'model-label.ts exports modelTriggerParts').toBe('function');
    const parts = mod!.modelTriggerParts;
    expect(parts({ label: 'sonnet-1m', id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', contextWindow: 1_000_000, family: 'sonnet', isDefault: false }))
      .toEqual({ family: 'Sonnet', context: '1M' });
    expect(parts({ label: 'opus', id: 'us.anthropic.claude-opus-4-1-20250805-v1:0', contextWindow: 200_000, family: 'opus', isDefault: true }))
      .toEqual({ family: 'Opus', context: '200K' });
    expect(parts({ label: 'haiku', id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', contextWindow: 200_000, family: 'haiku', isDefault: false }))
      .toEqual({ family: 'Haiku', context: '200K' });
  });
});
