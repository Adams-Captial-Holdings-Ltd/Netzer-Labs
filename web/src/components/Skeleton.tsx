interface SkeletonProps {
  class?: string;
  width?: string;
  height?: string;
  rounded?: boolean;
}

export function Skeleton({ class: className = '', width, height = '16px', rounded = false }: SkeletonProps) {
  return (
    <div
      class={`skeleton ${rounded ? 'rounded-full' : ''} ${className}`}
      style={{ width, height, minHeight: height }}
    />
  );
}

export function SkeletonText({ lines = 3, class: className = '' }: { lines?: number; class?: string }) {
  return (
    <div class={`space-y-2 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} height="14px" width={i === lines - 1 ? '60%' : '100%'} />
      ))}
    </div>
  );
}

export function SkeletonCard({ class: className = '' }: { class?: string }) {
  return (
    <div class={`bg-surface border border-border rounded-xl p-6 space-y-4 ${className}`}>
      <div class="flex items-center gap-3">
        <Skeleton width="40px" height="40px" rounded />
        <div class="flex-1 space-y-2">
          <Skeleton height="16px" width="50%" />
          <Skeleton height="12px" width="30%" />
        </div>
      </div>
      <SkeletonText lines={2} />
    </div>
  );
}

export function SkeletonTableRow({ cols = 5 }: { cols?: number }) {
  return (
    <tr>
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} class="px-4 py-3">
          <Skeleton height="14px" width={i === 0 ? '70%' : '50%'} />
        </td>
      ))}
    </tr>
  );
}
