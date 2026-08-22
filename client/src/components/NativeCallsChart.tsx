import { useMemo, useState } from "react";
import type { NativeCallsBucket, NativeCallsGranularity } from "../api/nativeCalls";

interface NativeCallsChartProps {
  data: NativeCallsBucket[];
  granularity: NativeCallsGranularity;
  height?: number;
}

const MARGIN = { top: 10, right: 12, bottom: 24, left: 34 };

/**
 * Calls over time for native harness tools.
 *
 * Its own component rather than LineChart because the two charts answer different questions with
 * different data: LineChart plots `UsageBucket` (calls vs *denied*, where denied is a governance
 * verdict) and its legend says so. Nothing here was ever grant-checked, so the second and third
 * series are "failed" and "blocked by the harness" — the same distinction the card's outcome
 * column exists to preserve. It reuses the chart *tokens* (--series-N, .chart-wrap,
 * .chart-legend) so the two read as one system.
 *
 * Calls are drawn as a filled area, not a bare line: this is a count per bucket and the area under
 * it is meaningful volume, which also keeps a mostly-zero series from looking like missing data.
 * The error and blocked series are only drawn when they have something in them — three flat lines
 * along zero is three times the ink for the same nothing.
 */
function formatBucket(iso: string, granularity: NativeCallsGranularity): string {
  const d = new Date(iso);
  if (granularity === "minute") {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit" });
}

function formatBucketFull(iso: string, granularity: NativeCallsGranularity): string {
  const d = new Date(iso);
  const end = new Date(d.getTime() + (granularity === "minute" ? 60_000 : 3_600_000));
  return `${d.toLocaleString()} → ${end.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

export function NativeCallsChart({ data, granularity, height = 200 }: NativeCallsChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const width = 640;
  const innerW = width - MARGIN.left - MARGIN.right;
  const innerH = height - MARGIN.top - MARGIN.bottom;

  const maxCalls = useMemo(() => Math.max(1, ...data.map((d) => d.calls)), [data]);
  const hasErrors = useMemo(() => data.some((d) => d.errors > 0), [data]);
  const hasDenied = useMemo(() => data.some((d) => d.denied > 0), [data]);

  const xFor = (i: number) => (data.length <= 1 ? 0 : (i / (data.length - 1)) * innerW);
  const yFor = (v: number) => innerH - (v / maxCalls) * innerH;

  const path = (key: "calls" | "errors" | "denied") =>
    data
      .map((d, i) => `${i === 0 ? "M" : "L"}${xFor(i).toFixed(1)},${yFor(d[key]).toFixed(1)}`)
      .join(" ");

  const area =
    data.length === 0
      ? ""
      : `${path("calls")} L${xFor(data.length - 1).toFixed(1)},${innerH} L0,${innerH} Z`;

  // Whole-number ticks only: fractional counts of tool calls are a lie the axis would be telling.
  const ticks = Math.min(4, maxCalls);
  const gridValues = Array.from(
    new Set(Array.from({ length: ticks + 1 }, (_, i) => Math.round((maxCalls / ticks) * i))),
  );

  const hovered = hoverIdx !== null ? data[hoverIdx] : null;
  const labelEvery = Math.max(1, Math.ceil(data.length / 7));

  function handleMove(e: React.MouseEvent<SVGRectElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const idx = Math.round((x / rect.width) * (data.length - 1));
    setHoverIdx(Math.min(Math.max(idx, 0), data.length - 1));
  }

  if (data.length === 0) return <div className="empty-state">No observations in this window.</div>;

  return (
    <div className="chart-wrap">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={`Native tool calls per ${granularity}`}
      >
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {gridValues.map((v) => (
            <g key={v}>
              <line x1={0} x2={innerW} y1={yFor(v)} y2={yFor(v)} stroke="var(--rule)" strokeWidth={1} />
              <text x={-8} y={yFor(v)} dy={4} textAnchor="end" fontSize={10} fill="var(--ink-muted)">
                {v}
              </text>
            </g>
          ))}
          <line x1={0} x2={innerW} y1={innerH} y2={innerH} stroke="var(--rule-strong)" strokeWidth={1} />

          <path d={area} fill="var(--series-1)" fillOpacity={0.16} stroke="none" />
          <path d={path("calls")} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinecap="round" />
          {hasErrors && (
            <path d={path("errors")} fill="none" stroke="var(--series-2)" strokeWidth={2} strokeLinecap="round" />
          )}
          {hasDenied && (
            <path d={path("denied")} fill="none" stroke="var(--series-3)" strokeWidth={2} strokeLinecap="round" />
          )}

          {data.map((d, i) =>
            i % labelEvery === 0 || i === data.length - 1 ? (
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
            ) : null,
          )}

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
              {hasErrors && <circle cx={xFor(hoverIdx)} cy={yFor(hovered.errors)} r={3} fill="var(--series-2)" />}
              {hasDenied && <circle cx={xFor(hoverIdx)} cy={yFor(hovered.denied)} r={3} fill="var(--series-3)" />}
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
      {/* Reserves its own line whether or not anything is hovered, so the chart doesn't jump the
          rest of the card down the page the first time a pointer crosses it. */}
      <div className="muted" style={{ fontSize: 12, minHeight: 18 }}>
        {hovered ? (
          <>
            <strong>{formatBucketFull(hovered.bucket, granularity)}</strong> — {hovered.calls} call
            {hovered.calls === 1 ? "" : "s"}
            {hovered.errors > 0 ? `, ${hovered.errors} failed` : ""}
            {hovered.denied > 0 ? `, ${hovered.denied} blocked` : ""}
          </>
        ) : (
          `Per ${granularity === "minute" ? "minute" : "hour"} — hover for a bucket.`
        )}
      </div>
      <div className="chart-legend">
        <span className="item">
          <span className="swatch" style={{ background: "var(--series-1)" }} /> Calls
        </span>
        {hasErrors && (
          <span className="item">
            <span className="swatch" style={{ background: "var(--series-2)" }} /> Failed
          </span>
        )}
        {hasDenied && (
          <span className="item">
            <span className="swatch" style={{ background: "var(--series-3)" }} /> Blocked by harness
          </span>
        )}
      </div>
    </div>
  );
}
