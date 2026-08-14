interface BarDatum {
  label: string;
  value: string | number;
}

interface BarChartProps {
  data: BarDatum[];
  color?: string;
  emptyLabel?: string;
}

/** Horizontal magnitude bars — single hue per chart (color follows the entity/measure,
 * never rank), with a direct value label on every bar since counts are small (top-N). */
export function BarChart({ data, color = "var(--series-1)", emptyLabel = "No data yet." }: BarChartProps) {
  if (data.length === 0) return <div className="empty-state">{emptyLabel}</div>;
  const max = Math.max(1, ...data.map((d) => Number(d.value) || 0));
  return (
    <div>
      {data.map((d) => {
        const pct = Math.max(2, (Number(d.value) / max) * 100);
        return (
          <div className="bar-row" key={d.label}>
            <div className="bar-label" title={d.label}>
              {d.label}
            </div>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${pct}%`, background: color }} />
            </div>
            <div className="bar-value tabular">{d.value}</div>
          </div>
        );
      })}
    </div>
  );
}
