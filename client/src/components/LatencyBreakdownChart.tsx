import { useMemo, useState } from "react";
import type { UsageBucket, UsageGranularity } from "../api/types";

interface LatencyBreakdownChartProps {
  data: UsageBucket[];
  granularity?: UsageGranularity;
  height?: number;
}

const MARGIN = { top: 10, right: 12, bottom: 24, left: 36 };

type PhaseKey =
  | "avgLatencyMs"
  | "avgCapabilityLookupMs"
  | "avgPrincipalResolveMs"
  | "avgBrokerMs"
  | "avgGrantCheckMs";

// "Total" is the full round-trip latency (tool + harness overhead combined) — it isn't just the
// sum of the phases below (those cover the governance path only, not the tool's own execution
// time), so it's offered as an opt-in series rather than shown by default alongside them.
const TOTAL_PHASE: { key: PhaseKey; label: string; color: string } = {
  key: "avgLatencyMs",
  label: "Total (tool + harness)",
  color: "var(--ink)",
};

const PHASES: { key: PhaseKey; label: string; color: string }[] = [
  { key: "avgCapabilityLookupMs", label: "Capability lookup", color: "var(--series-1)" },
  { key: "avgPrincipalResolveMs", label: "Principal resolve", color: "var(--series-2)" },
  { key: "avgBrokerMs", label: "Broker", color: "var(--series-3)" },
  { key: "avgGrantCheckMs", label: "Grant check", color: "var(--series-4)" },
];

const ALL_PHASES = [TOTAL_PHASE, ...PHASES];

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

/** Latency-breakdown-over-time chart: one line per phase (docs/design/latency-breakdown.md),
 * sharing a milliseconds y-axis, with a hover crosshair + tooltip and a checkbox legend (4 phases
 * on by default, plus an opt-in "Total (tool + harness)" series drawn dashed since it's on a
 * different scale). Phases with no value in a bucket (null, not 0 — predates the breakdown, or
 * failed open before that phase ran) simply leave a gap in that line rather than drawing a
 * misleading dip to zero. */
export function LatencyBreakdownChart({ data, granularity = "day", height = 220 }: LatencyBreakdownChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  // Total is opt-in (see TOTAL_PHASE) since it's on a different scale from the phase breakdown;
  // the four phases stay on by default, matching the chart's previous always-on behavior.
  const [visible, setVisible] = useState<Set<PhaseKey>>(() => new Set(PHASES.map((p) => p.key)));
  const activePhases = ALL_PHASES.filter((p) => visible.has(p.key));
  const width = 640;
  const innerW = width - MARGIN.left - MARGIN.right;
  const innerH = height - MARGIN.top - MARGIN.bottom;

  function toggle(key: PhaseKey) {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const maxMs = useMemo(
    () =>
      Math.max(
        1,
        ...data.flatMap((d) => activePhases.map((p) => d[p.key]).filter((v): v is number => v !== null)),
      ),
    [data, activePhases],
  );

  const xFor = (i: number) => (data.length <= 1 ? 0 : (i / (data.length - 1)) * innerW);
  const yFor = (v: number) => innerH - (v / maxMs) * innerH;

  // Break the path at any null value instead of interpolating across a gap in the phase's data.
  const pathFor = (key: PhaseKey) => {
    let d = "";
    let pendingMove = true;
    data.forEach((bucket, i) => {
      const v = bucket[key];
      if (v === null) {
        pendingMove = true;
        return;
      }
      d += `${pendingMove ? "M" : "L"}${xFor(i).toFixed(1)},${yFor(v).toFixed(1)} `;
      pendingMove = false;
    });
    return d.trim();
  };

  const ticks = 4;
  const gridValues = Array.from({ length: ticks + 1 }, (_, i) => Math.round((maxMs / ticks) * i));

  const hovered = hoverIdx !== null ? data[hoverIdx] : null;
  const hasAnyData = data.some((d) => ALL_PHASES.some((p) => d[p.key] !== null));

  function handleMove(e: React.MouseEvent<SVGRectElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const idx = Math.round((x / innerW) * (data.length - 1));
    setHoverIdx(Math.min(Math.max(idx, 0), data.length - 1));
  }

  if (data.length === 0 || !hasAnyData) {
    return <div className="empty-state">No latency-breakdown data yet.</div>;
  }

  return (
    <div className="chart-wrap">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label="Latency breakdown over time"
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

          {activePhases.map((p) => (
            <path
              key={p.key}
              d={pathFor(p.key)}
              fill="none"
              stroke={p.color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeDasharray={p.key === "avgLatencyMs" ? "5,3" : undefined}
            />
          ))}

          {activePhases.map((p) =>
            data.map((d, i) => {
              const v = d[p.key];
              if (v === null) return null;
              return <circle key={`${p.key}-${d.bucket}`} cx={xFor(i)} cy={yFor(v)} r={2.5} fill={p.color} />;
            }),
          )}

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
              {activePhases.map((p) => {
                const v = hovered[p.key];
                if (v === null) return null;
                return <circle key={p.key} cx={xFor(hoverIdx)} cy={yFor(v)} r={4} fill={p.color} />;
              })}
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
          <strong>{formatBucketFull(hovered.bucket, granularity)}</strong> —{" "}
          {activePhases.map((p) => `${p.label}: ${hovered[p.key] === null ? "—" : `${hovered[p.key]}ms`}`).join(", ")}
        </div>
      )}
      <div className="chart-legend">
        {ALL_PHASES.map((p) => (
          <label className="item" key={p.key} style={{ cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={visible.has(p.key)}
              onChange={() => toggle(p.key)}
              style={{ marginRight: 4 }}
            />
            <span className="swatch" style={{ background: p.color }} /> {p.label}
          </label>
        ))}
      </div>
    </div>
  );
}
