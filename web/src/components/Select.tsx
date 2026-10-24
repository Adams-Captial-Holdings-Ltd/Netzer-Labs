import { useState, useRef, useEffect } from 'preact/hooks';

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  class?: string;
  placeholder?: string;
  size?: 'sm' | 'md';
  /** Lets a <label for> name the trigger button. */
  id?: string;
  /** Not openable. The trigger shows the selected label as muted text. */
  disabled?: boolean;
  /** Extra classes for the trigger button, such as a taller touch size. */
  triggerClass?: string;
}

export function Select({
  value, onChange, options, class: className = '', placeholder, size = 'sm', id, disabled = false, triggerClass = '',
}: SelectProps) {
  const [open, setOpen] = useState(false);
  // Open upward when the trigger sits too close to the viewport bottom for the
  // list to fit below (e.g. the Jarvis model picker in the page foot) — an
  // absolutely-positioned menu would otherwise clip off-screen.
  const [flipUp, setFlipUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  function toggleOpen() {
    if (disabled) return;
    if (!open && ref.current) {
      const r = ref.current.getBoundingClientRect();
      const estListHeight = Math.min(options.length * 38 + 10, 240); // max-h-60 cap
      setFlipUp(window.innerHeight - r.bottom < estListHeight && r.top > estListHeight);
    }
    setOpen(!open);
  }

  const selected = options.find((o) => o.value === value);
  const label = selected?.label ?? placeholder ?? 'Select...';

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, []);

  useEffect(() => {
    if (open && listRef.current) {
      const active = listRef.current.querySelector('[data-active="true"]');
      if (active) (active as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  }, [open]);

  const pad = size === 'sm' ? 'px-3 py-1.5' : 'px-3 py-2';

  return (
    <div ref={ref} class={`relative inline-block ${className}`}>
      <button
        id={id}
        type="button"
        disabled={disabled}
        onClick={toggleOpen}
        class={`flex items-center gap-2 bg-surface border border-border rounded-lg ${pad} text-body-sm
          outline-none focus-visible:ring-2 focus-visible:ring-primary hover:border-border-strong transition-colors
          disabled:cursor-not-allowed disabled:opacity-60
          ${disabled ? 'text-secondary' : !selected ? 'text-muted' : 'text-primary'} ${triggerClass}`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span class="truncate">{label}</span>
        <svg class={`w-4 h-4 shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div
          ref={listRef}
          class={`absolute z-50 w-full min-w-[160px] bg-surface border border-border rounded-lg shadow-lg py-1 max-h-60 overflow-y-auto page-enter ${flipUp ? 'bottom-full mb-1' : 'top-full mt-1'}`}
          role="listbox"
          aria-activedescendant={value}
        >
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="option"
              aria-selected={opt.value === value}
              data-active={opt.value === value}
              onClick={() => { onChange(opt.value); setOpen(false); }}
              class={`w-full text-left px-3 py-2 max-md:py-3 text-body-sm transition-colors
                ${opt.value === value
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-secondary hover:bg-surface-hover hover:text-primary'}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
