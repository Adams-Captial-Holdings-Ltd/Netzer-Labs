/* SPIKE HARNESS (branch spike/preact-compat) — mounts donor LibreChat source,
 * copied byte-for-byte, under preact/compat. Not part of the product.
 *
 * Three donor surfaces are exercised:
 *   1. the Ariakit nested menu with per-level search (CustomMenu.tsx, verbatim)
 *   2. the message markdown pipeline (Markdown.tsx + MarkdownBlocks.tsx +
 *      splitMarkdown.ts + animate.tsx + MarkdownComponents.tsx, all verbatim)
 *   3. the composer textarea (donor TextareaAutosize call site, verbatim props)
 */
import { useState, useRef } from 'react';
import {
  CustomMenu as Menu,
  CustomMenuGroup,
  CustomMenuSeparator,
} from '~/components/Chat/Menus/Endpoints/CustomMenu';
import { renderModelSpecs } from '~/components/Chat/Menus/Endpoints/components/ModelSpecItem';
import { ModelSelectorContext } from '~/components/Chat/Menus/Endpoints/ModelSelectorContext';
import type { TModelSpec } from 'librechat-data-provider';
import Markdown from '~/components/Chat/Messages/Content/Markdown';
import { MessageProvider } from '~/Providers';
import { TextareaAutosize } from '@librechat/client';
import { cn } from '~/utils';

const OPENAI: TModelSpec[] = [
  { name: 'gpt-4o', label: 'GPT-4o', description: 'Fast, multimodal flagship' },
  { name: 'gpt-4o-mini', label: 'GPT-4o mini', description: 'Cheap and quick' },
  { name: 'o3', label: 'o3', description: 'Reasoning' },
];
const ANTHROPIC: TModelSpec[] = [
  { name: 'claude-opus-4', label: 'Claude Opus 4', description: 'Deepest reasoning' },
  { name: 'claude-sonnet-4', label: 'Claude Sonnet 4', description: 'Balanced' },
  { name: 'claude-haiku-4', label: 'Claude Haiku 4', description: 'Fastest' },
];
const NETZAR: TModelSpec[] = [
  { name: 'netzar-ops', label: 'Netzar Ops', description: 'Ops copilot' },
  { name: 'netzar-sec', label: 'Netzar Sec', description: 'Security analyst' },
];

const FENCE = '```';
const SAMPLE = [
  '# Markdown pipeline',
  '',
  'Streaming **bold**, _italic_, `inline code`, and a [link](https://example.com).',
  '',
  '| surface | adapter | parity |',
  '| --- | --- | --- |',
  '| Telegram | handler.ts | yes |',
  '| Slack | handler.ts | two paths |',
  '| Dashboard | /api/test-turn | yes |',
  '',
  FENCE + 'ts',
  'export function add(a: number, b: number): number {',
  '  return a + b;',
  '}',
  FENCE,
  '',
  '1. First',
  '2. Second',
  '   - nested',
  '   - items',
  '',
  '> A blockquote, followed by a rule.',
  '',
  '---',
  '',
  'Display math: $$e^{i\\pi} + 1 = 0$$',
  '',
  '- [x] mounts',
  '- [ ] interacts',
  '',
].join('\n');

export default function SpikeRoute() {
  const [values, setValues] = useState<Record<string, unknown>>({ modelSpec: 'claude-sonnet-4' });
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState('claude-sonnet-4');
  const [text, setText] = useState('');
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);

  const all = [...OPENAI, ...ANTHROPIC, ...NETZAR];
  const q = search.trim().toLowerCase();
  const hits = q ? all.filter((s) => s.label.toLowerCase().includes(q)) : null;

  return (
    <ModelSelectorContext.Provider
      value={{
        handleSelectSpec: (spec) => setPicked(spec.name),
        endpointsConfig: {},
        agentsMap: undefined,
      }}
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-8 p-6 text-text-primary">
        <section data-testid="spike-menu">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-text-secondary">
            1. Ariakit nested menu (donor CustomMenu.tsx, verbatim)
          </h2>
          <p className="mb-3 text-xs text-text-secondary">
            selected: <span data-testid="spike-picked">{picked}</span>
          </p>
          <Menu
            values={values}
            onValuesChange={(next: Record<string, unknown>) => setValues(next)}
            onSearch={(v: string) => setSearch(v)}
            combobox={<input id="model-search" placeholder=" " />}
            comboboxLabel="Search models"
            trigger={
              <button
                data-testid="model-selector-button"
                className="my-1 flex h-9 max-w-full items-center gap-2 rounded-xl border border-border-light bg-presentation px-3 py-2 text-sm text-text-primary hover:bg-surface-active-alt"
              >
                <span className="truncate text-left">{picked}</span>
              </button>
            }
          >
            {hits ? (
              renderModelSpecs(hits, picked)
            ) : (
              <>
                <CustomMenuGroup label="Favorites">
                  {renderModelSpecs(NETZAR, picked)}
                </CustomMenuGroup>
                <CustomMenuSeparator />
                <Menu label="OpenAI" values={values} onValuesChange={setValues}>
                  {renderModelSpecs(OPENAI, picked)}
                </Menu>
                <Menu label="Anthropic" values={values} onValuesChange={setValues}>
                  {renderModelSpecs(ANTHROPIC, picked)}
                </Menu>
              </>
            )}
          </Menu>
        </section>

        <section data-testid="spike-markdown">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-text-secondary">
            2. Message markdown (donor Markdown.tsx chain, verbatim)
          </h2>
          <div className="rounded-xl border border-border-light p-4">
            <MessageProvider isSubmitting={false}>
              <Markdown content={SAMPLE} isLatestMessage={false} />
            </MessageProvider>
          </div>
        </section>

        <section data-testid="spike-composer">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-text-secondary">
            3. Composer textarea (donor call site, verbatim props)
          </h2>
          <div className="relative flex w-full flex-grow flex-col overflow-hidden rounded-3xl border border-border-light bg-surface-chat text-text-primary shadow-md transition-all duration-200">
            <div className="flex flex-row">
              <div className="relative flex-1">
                {/* Verbatim shape from donor ChatForm.tsx lines 608-641, minus
                    the react-hook-form register spread and the seven coupled
                    handlers (steering, answer-mode, paste routing). */}
                <TextareaAutosize
                  ref={(e: HTMLTextAreaElement | null) => {
                    textAreaRef.current = e;
                  }}
                  value={text}
                  onChange={(e) => setText((e.target as HTMLTextAreaElement).value)}
                  id="prompt-textarea"
                  tabIndex={0}
                  data-testid="text-input"
                  rows={1}
                  aria-label="Message input"
                  placeholder="Message Netzar..."
                  style={{ height: 44, overflowY: 'auto' } as never}
                  className={cn(
                    'm-0 w-full resize-none bg-transparent py-[10px] placeholder-black/50 dark:placeholder-white/50 md:py-3.5',
                    'max-h-[45vh] pl-3 pr-3 sm:max-h-[45vh] md:max-h-[55vh]',
                    'focus:outline-none focus:ring-0 focus:ring-offset-0',
                    'scrollbar-hover transition-[max-height] duration-200 disabled:cursor-not-allowed',
                  )}
                />
              </div>
            </div>
          </div>
          <p className="mt-2 text-xs text-text-secondary">
            lines: <span data-testid="spike-rows">{text.split('\n').length}</span>
          </p>
        </section>
      </div>
    </ModelSelectorContext.Provider>
  );
}

