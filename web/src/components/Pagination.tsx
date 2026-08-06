import { Select } from './Select';

interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  pageSizeOptions?: number[];
}

export function Pagination({ page, pageSize, total, onPageChange, onPageSizeChange, pageSizeOptions = [25, 50, 100] }: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = Math.min(page * pageSize + 1, total);
  const end = Math.min((page + 1) * pageSize, total);

  return (
    <div class="flex items-center justify-between px-4 py-3 border-t border-border">
      <div class="flex items-center gap-3">
        <span class="text-caption text-muted">Rows per page</span>
        <Select
          value={String(pageSize)}
          onChange={(v) => { onPageSizeChange(Number(v)); onPageChange(0); }}
          options={pageSizeOptions.map((n) => ({ value: String(n), label: String(n) }))}
        />
        <span class="text-caption text-muted">
          {start}--{end} of {total.toLocaleString()}
        </span>
      </div>
      <div class="flex items-center gap-1">
        <button
          onClick={() => onPageChange(0)}
          disabled={page === 0}
          class="p-1.5 rounded-lg text-secondary hover:bg-surface-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          aria-label="First page"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><polyline points="11 17 6 12 11 7" /><polyline points="18 17 13 12 18 7" /></svg>
        </button>
        <button
          onClick={() => onPageChange(page - 1)}
          disabled={page === 0}
          class="p-1.5 rounded-lg text-secondary hover:bg-surface-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          aria-label="Previous page"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
        </button>
        <span class="px-3 py-1 text-body-sm text-primary font-medium">
          {page + 1} / {totalPages}
        </span>
        <button
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages - 1}
          class="p-1.5 rounded-lg text-secondary hover:bg-surface-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          aria-label="Next page"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
        </button>
        <button
          onClick={() => onPageChange(totalPages - 1)}
          disabled={page >= totalPages - 1}
          class="p-1.5 rounded-lg text-secondary hover:bg-surface-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          aria-label="Last page"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 17 18 12 13 7" /><polyline points="6 17 11 12 6 7" /></svg>
        </button>
      </div>
    </div>
  );
}
