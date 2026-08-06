import { useState } from 'preact/hooks';

interface BarChartProps {
  data: { label: string; value: number }[];
  color?: string;
  height?: number;
  formatValue?: (v: number) => string;
}

export function BarChart({ data, color = 'var(--color-accent)', height = 180, formatValue = (v) => `$${v.toFixed(2)}` }: BarChartProps) {
  const [hovered, setHovered] = useState<number | null>(null);
  if (!data.length) return null;
  const max = Math.max(...data.map((d) => d.value), 0.01);
  const barWidth = Math.max(12, Math.min(40, Math.floor(600 / data.length) - 4));
  const chartWidth = data.length * (barWidth + 4) + 40;

  return (
    <div class="overflow-x-auto">
      <svg width={chartWidth} height={height + 28} class="block">
        {[0.25, 0.5, 0.75, 1].map((frac) => {
          const y = height - frac * (height - 20);
          return (
            <line
              x1="36" y1={y} x2={chartWidth} y2={y}
              stroke="var(--color-border)" stroke-width="0.5" stroke-dasharray="3,3"
            />
          );
        })}
        {data.map((d, i) => {
          const barH = Math.max(1, (d.value / max) * (height - 24));
          const x = 40 + i * (barWidth + 4);
          const y = height - barH;
          return (
            <g
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
            >
              <rect
                x={x} y={y} width={barWidth} height={barH}
                rx="2"
                fill={hovered === i ? 'var(--color-accent)' : color}
                opacity={hovered === i ? 1 : 0.7}
              />
              {hovered === i && (
                <text x={x + barWidth / 2} y={y - 4} text-anchor="middle" fill="var(--color-text-primary)" font-size="10">
                  {formatValue(d.value)}
                </text>
              )}
              <text x={x + barWidth / 2} y={height + 14} text-anchor="middle" fill="var(--color-text-muted)" font-size="9">
                {d.label.slice(5)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
