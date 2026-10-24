import { useEffect, useRef, useState } from 'preact/hooks';
import { CheckIcon, ChevronDownIcon } from 'lucide-preact';
import { cn } from '@/lib/utils';

export interface SelectOption {
  value: string;
  label?: string;
  disabled?: boolean;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  placeholder?: string;
  /** If set, renders a leading row that selects '' (e.g. "all slots"). */
  emptyLabel?: string;
  /** Show a filter input at the top of the open list. */
  filterable?: boolean;
  /** Typed text that matches nothing becomes a "use" row (needs filterable). */
  allowCustom?: boolean;
  disabled?: boolean;
  className?: string;
  onChange: (value: string) => void;
}

const itemCls =
  'relative flex w-full cursor-default items-center gap-1.5 rounded-md py-1 pl-1.5 pr-2 text-sm select-none outline-none';
const activeCls = 'bg-accent text-accent-foreground';

/**
 * Flat dropdown — the same shell/behavior as NestedDropdown without the
 * cascade. Pure DOM content (no native popup), so it behaves in the
 * frameless Electron overlay where native <select> popups get killed.
 * `filterable` adds a text filter; `allowCustom` turns the filter text
 * into a free-form value row.
 */
export function Select({
  value,
  options,
  placeholder = 'select…',
  emptyLabel,
  filterable = false,
  allowCustom = false,
  disabled,
  className,
  onChange,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState(0);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const q = query.trim().toLowerCase();
  const visible = q
    ? options.filter((o) =>
        (o.label ?? o.value).toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
      )
    : options;
  const rows: SelectOption[] = [
    ...(emptyLabel != null ? [{ value: '', label: emptyLabel }] : []),
    ...visible,
  ];
  const customValue = query.trim();
  const showCustom =
    filterable &&
    allowCustom &&
    customValue !== '' &&
    !options.some((o) => o.value.toLowerCase() === customValue.toLowerCase());
  if (showCustom) rows.push({ value: customValue, label: '' }); // rendered specially

  const selected = options.find((o) => o.value === value);
  const label = selected?.label ?? selected?.value ?? (value !== '' ? value : '');

  const close = () => {
    setOpen(false);
    setQuery('');
  };
  const choose = (v: string) => {
    onChange(v);
    close();
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      const cur = rows.findIndex((o) => o.value === value);
      setHl(cur >= 0 ? cur : 0);
      inputRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-row="${hl}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [hl]);

  const step = (dir: 1 | -1) =>
    setHl((h) => {
      for (let i = h + dir; i >= 0 && i < rows.length; i += dir) {
        if (!rows[i].disabled) return i;
      }
      return h;
    });

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        step(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        step(-1);
        break;
      case 'Enter':
        e.preventDefault();
        if (rows[hl] && !rows[hl].disabled) choose(rows[hl].value);
        break;
      case 'Escape':
        e.preventDefault();
        close();
        break;
      case 'Tab':
        close();
        break;
    }
  };

  return (
    <div ref={rootRef} className={cn('relative', className)} onKeyDown={onKeyDown}>
      <button
        type="button"
        data-slot="select-trigger"
        aria-expanded={open}
        disabled={disabled}
        className={cn(
          'flex h-8 w-full items-center justify-between gap-1.5 whitespace-nowrap rounded-lg border border-input bg-transparent py-2 pl-2.5 pr-2 text-sm outline-none transition-colors select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
          !label && 'text-muted-foreground',
        )}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="line-clamp-1 flex-1 text-left">{label || placeholder}</span>
        <ChevronDownIcon className="size-4 text-muted-foreground" />
      </button>

      {open && (
        <div
          data-slot="select-content"
          className="absolute isolate z-50 mt-1 w-max min-w-full overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10"
        >
          {filterable && (
            <input
              ref={inputRef}
              className="h-8 w-full border-b border-border bg-transparent px-2.5 text-sm outline-none placeholder:text-muted-foreground"
              placeholder="filter…"
              value={query}
              onInput={(e) => {
                setQuery((e.target as HTMLInputElement).value);
                setHl(0);
              }}
            />
          )}
          <div ref={listRef} role="listbox" className="max-h-60 overflow-y-auto p-1">
            {rows.length === 0 && (
              <p className="px-1.5 py-2 text-xs text-muted-foreground">no options</p>
            )}
            {rows.map((o, i) => {
              const isCustom = showCustom && i === rows.length - 1;
              const isSel = o.value === value || (o.value === '' && !selected);
              return (
                <div
                  key={o.value === '' ? '__empty' : isCustom ? '__custom' : o.value}
                  role="option"
                  aria-selected={isSel}
                  aria-disabled={o.disabled || undefined}
                  data-row={i}
                  className={cn(
                    itemCls,
                    'pr-8',
                    i === hl && !o.disabled && activeCls,
                    o.disabled
                      ? 'cursor-not-allowed text-muted-foreground opacity-50'
                      : o.value === '' && !isCustom && 'italic text-muted-foreground',
                  )}
                  onMouseEnter={() => !o.disabled && setHl(i)}
                  onClick={() => !o.disabled && choose(o.value)}
                >
                  {isCustom ? (
                    <span className="flex-1 truncate">
                      use <span className="font-medium">{o.value}</span>
                    </span>
                  ) : (
                    <span className="flex-1 truncate">{o.label ?? o.value}</span>
                  )}
                  {isSel && !isCustom && (
                    <CheckIcon className="pointer-events-none absolute right-2 size-4" />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
