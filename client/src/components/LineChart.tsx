import { useMemo, useState } from "react";
import type { UsageBucket, UsageGranularity } from "../api/types";

interface LineChartProps {
  data: UsageBucket[];
  granularity?: UsageGranularity;
  height?: number;
}

const MARGIN = { top: 10, right: 12, bottom: 24, left: 32 };

/** Formats a bucket's ISO start timestamp for the axis/tooltip, at a grain matching the data:
 * a "minute" bucket shows a clock time, an "hour" bucket a day + hour, a "day" bucket a date. */
function formatBucket(iso: string, granularity: UsageGranularity): string {
  const d = new Date(iso);
  if (granularity === "minute") {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  if (granularity === "hour") {
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit" });
  }
  return iso.slice(5, 10);
}

function formatBucketFull(iso: string, granularity: UsageGranularity): string {
  const d = new Date(iso);
  if (granularity === "day") return d.toLocaleDateString();
  return d.toLocaleString();
}

/** Calls-over-time line chart: two series (calls, denied) sharing one y-axis (count),
 * with a hover crosshair + tooltip, gridlines, and a legend (required at 2+ series). */
export function LineChart({ data, granularity = "day", height = 220 }: LineChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const width = 640;
  const innerW = width - MARGIN.left - MARGIN.right;
  const innerH = height - MARGIN.top - MARGIN.bottom;

  const maxCalls = useMemo(
    () => Math.max(1, ...data.map((d) => Math.max(d.calls, d.denied))),
    [data],
  );

  const xFor = (i: number) => (data.length <= 1 ? 0 : (i / (data.length - 1)) * innerW);
  const yFor = (v: number) => innerH - (v / maxCalls) * innerH;

  const path = (key: "calls" | "denied") =>
    data.map((d, i) => `${i === 0 ? "M" : "L"}${xFor(i).toFixed(1)},${yFor(d[key]).toFixed(1)}`).join(" ");

  const ticks = 4;
  const gridValues = Array.from({ length: ticks + 1 }, (_, i) => Math.round((maxCalls / ticks) * i));

  const hovered = hoverIdx !== null ? data[hoverIdx] : null;

  function handleMove(e: React.MouseEvent<SVGRectElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const idx = Math.round((x / innerW) * (data.length - 1));
    setHoverIdx(Math.min(Math.max(idx, 0), data.length - 1));
  }

  if (data.length === 0) return <div className="empty-state">No usage data yet.</div>;

  return (
    <div className="chart-wrap">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label="Calls over time"
      >
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {gridValues.map((v) => (
            <g key={v}>
              <line
                x1={0}
                x2={innerW}
                y1={yFor(v)}
                y2={yFor(v)}
                stroke="var(--rule)"
                strokeWidth={1}
              />
              <text x={-8} y={yFor(v)} dy={4} textAnchor="end" fontSize={10} fill="var(--ink-muted)">
                {v}
              </text>
            </g>
          ))}
          <line x1={0} x2={innerW} y1={innerH} y2={innerH} stroke="var(--rule-strong)" strokeWidth={1} />

          <path d={path("calls")} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinecap="round" />
          <path d={path("denied")} fill="none" stroke="var(--series-2)" strokeWidth={2} strokeLinecap="round" />

          {data.map((d, i) => {
            if (i % Math.ceil(data.length / 7) !== 0 && i !== data.length - 1) return null;
            return (
              <text
                key={d.bucket}
                x={xFor(i)}
                y={innerH + 16}
                fontSize={10}
                textAnchor="middle"
                fill="var(--ink-muted)"
              >
                {formatBucket(d.bucket, granularity)}
              </text>
            );
          })}

          {hovered && hoverIdx !== null && (
            <g>
              <line
                x1={xFor(hoverIdx)}
                x2={xFor(hoverIdx)}
                y1={0}
                y2={innerH}
                stroke="var(--ink-muted)"
                strokeWidth={1}
                strokeDasharray="3,3"
              />
              <circle cx={xFor(hoverIdx)} cy={yFor(hovered.calls)} r={4} fill="var(--series-1)" />
              <circle cx={xFor(hoverIdx)} cy={yFor(hovered.denied)} r={4} fill="var(--series-2)" />
            </g>
          )}

          <rect
            x={0}
            y={0}
            width={innerW}
            height={innerH}
            fill="transparent"
            onMouseMove={handleMove}
            onMouseLeave={() => setHoverIdx(null)}
          />
        </g>
      </svg>
      {hovered && (
        <div className="muted" style={{ fontSize: 12 }}>
          <strong>{formatBucketFull(hovered.bucket, granularity)}</strong> — calls: {hovered.calls}, denied:{" "}
          {hovered.denied}
        </div>
      )}
      <div className="chart-legend">
        <span className="item">
          <span className="swatch" style={{ background: "var(--series-1)" }} /> Calls
        </span>
        <span className="item">
          <span className="swatch" style={{ background: "var(--series-2)" }} /> Denied
        </span>
      </div>
    </div>
  );
}
