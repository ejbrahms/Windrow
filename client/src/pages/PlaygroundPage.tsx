import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CAP_BY_NAME,
  CAPABILITIES,
  PRINCIPALS,
  decide,
  latencyFor,
  riskLabel,
} from "./playground/sim";
import type { Latency, Outcome, RiskTier, SimCapability, SimPrincipal } from "./playground/sim";
import { LineChart } from "../components/LineChart";
import type { UsageBucket } from "../api/types";
import "../styles/playground.css";

/**
 * A playful, entirely client-side terminal that lets a visitor fire fake MCP tool calls at a fake
 * agent and watch the windrow broker allow, deny or escalate each one — live, with the same
 * vocabulary (principals, capabilities, risk tiers, grants) the real dashboard uses. Nothing here
 * touches the network: every decision is computed in the browser by ./playground/sim so the public
 * demo can run it with no backend and no writes. It is a toy of the /api/invoke path, made obvious
 * as one — see the "simulated, in your browser" note in the header.
 */

type Line =
  | { id: number; type: "cmd"; principal: string; cap: string }
  | { id: number; type: "phase"; text: string }
  | { id: number; type: "decision"; outcome: Outcome; reason: string }
  | { id: number; type: "result"; cap: string; payload: Record<string, unknown> }
  | { id: number; type: "note"; text: string; tone?: "dim" | "warn" };

const OUTCOME_LABEL: Record<Outcome, string> = {
  ok: "ALLOWED",
  approved: "APPROVED",
  denied: "DENIED",
  error: "ERROR",
};

const OUTCOME_TONE: Record<Outcome, string> = {
  ok: "badge-ok",
  approved: "badge-approved",
  denied: "badge-denied",
  error: "badge-error",
};

// One resolved call, recorded the moment the broker settles it — the row the events log renders and
// the point the calls-over-time chart buckets. Same shape idea as a real UsageEvent, trimmed to
// what a browser-only toy can honestly know.
interface SimEvent {
  id: number;
  ts: number;
  principal: string;
  capability: string;
  riskTier: RiskTier | null;
  outcome: Outcome;
  latencyMs: number | null;
  result: Record<string, unknown> | null;
  reason: string;
}

// The chart's rolling window: one-minute buckets over the last 20 minutes, the same minute
// granularity the Fleet events page uses so this reads as the same chart on invented data.
const BUCKET_MS = 60_000;
const WINDOW_MS = 20 * BUCKET_MS;

/** Bucket the recorded calls into the LineChart's UsageBucket shape — calls total plus the denied
 *  subset, per minute, across a window ending at `now` so the series scrolls as time passes. */
function bucketize(events: SimEvent[], now: number): UsageBucket[] {
  const end = Math.floor(now / BUCKET_MS) * BUCKET_MS;
  const start = end - WINDOW_MS;
  const buckets: UsageBucket[] = [];
  const index = new Map<number, UsageBucket>();
  for (let t = start; t <= end; t += BUCKET_MS) {
    const b: UsageBucket = {
      bucket: new Date(t).toISOString(),
      calls: 0,
      denied: 0,
      avgLatencyMs: null,
      avgCapabilityLookupMs: null,
      avgPrincipalResolveMs: null,
      avgBrokerMs: null,
      avgGrantCheckMs: null,
    };
    buckets.push(b);
    index.set(t, b);
  }
  for (const e of events) {
    const key = Math.floor(e.ts / BUCKET_MS) * BUCKET_MS;
    const b = index.get(key);
    if (!b) continue;
    b.calls += 1;
    if (e.outcome === "denied") b.denied += 1;
  }
  return buckets;
}

function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function summarize(e: SimEvent): string {
  if (e.result) return formatPayload(e.result);
  return e.reason;
}

// Omit over a discriminated union has to distribute, or it collapses to the shared keys (just
// `type`) and every variant's own fields become "unknown property" errors. Distribution only
// happens over a naked type parameter, hence the generic rather than `Omit<Line, "id">` inline.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type DraftLine = DistributiveOmit<Line, "id">;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function PlaygroundPage() {
  const [principal, setPrincipal] = useState<SimPrincipal>(PRINCIPALS[0]);
  const [lines, setLines] = useState<Line[]>([
    { id: 0, type: "note", text: "windrow sandbox — pick an agent, fire a tool call, watch the broker rule on it.", tone: "dim" },
    { id: 1, type: "note", text: "Everything here runs in your browser. No calls leave the page.", tone: "dim" },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState({ allowed: 0, denied: 0, approved: 0 });
  // When a destructive, ungranted call is escalated we pause the stream and wait on the human,
  // exactly as the real approval queue does — the resolver lives here until they click.
  const [pending, setPending] = useState<{ principal: SimPrincipal; cap: SimCapability } | null>(null);
  // Every resolved call, newest first — the events log below, and the points the chart buckets.
  const [events, setEvents] = useState<SimEvent[]>([]);
  const [onlyProblems, setOnlyProblems] = useState(false);
  // A once-a-second clock so the calls-over-time window scrolls left even when nothing is firing —
  // the live tail every fleet chart has, on data that is entirely local.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const idRef = useRef(2);
  const seqRef = useRef(0);
  const approvalResolve = useRef<((approved: boolean) => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const nextId = () => idRef.current++;
  const push = useCallback((line: DraftLine) => {
    setLines((prev) => [...prev, { ...line, id: nextId() } as Line]);
  }, []);

  // Keep the newest line in view as the stream grows.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [lines, pending]);

  const bump = (o: Outcome) =>
    setStats((s) => ({
      allowed: s.allowed + (o === "ok" ? 1 : 0),
      denied: s.denied + (o === "denied" ? 1 : 0),
      approved: s.approved + (o === "approved" ? 1 : 0),
    }));

  // Append a resolved call to the log. Capped so a long play session can't grow the table without
  // bound; newest first, the order the events page tails in.
  const record = useCallback((e: Omit<SimEvent, "id" | "ts">) => {
    setEvents((prev) => [{ ...e, id: idRef.current++, ts: Date.now() }, ...prev].slice(0, 100));
  }, []);

  const streamPhases = useCallback(
    async (lat: Latency) => {
      push({ type: "phase", text: `capability lookup … ${lat.capabilityLookup}ms` });
      await sleep(220);
      push({ type: "phase", text: `resolve principal … ${lat.principalResolve}ms` });
      await sleep(220);
      push({ type: "phase", text: `check grants … ${lat.grantCheck}ms` });
      await sleep(260);
    },
    [push],
  );

  const emitResult = useCallback(
    (cap: SimCapability, who: SimPrincipal, outcome: Outcome) => {
      const payload = cap.result({ principal: who, seq: seqRef.current++ });
      push({ type: "result", cap: cap.name, payload });
      bump(outcome);
      return payload;
    },
    [push],
  );

  // Run one tool call through the broker, streaming each step. Returns when the call has fully
  // resolved (including any human approval it had to wait on).
  const runCall = useCallback(
    async (who: SimPrincipal, cap: SimCapability) => {
      push({ type: "cmd", principal: who.name, cap: cap.name });
      await sleep(160);
      const lat = latencyFor(seqRef.current);
      await streamPhases(lat);

      const base = { principal: who.name, capability: cap.name, riskTier: cap.riskTier, latencyMs: lat.total };
      const decision = decide(who, cap);
      if (decision.kind === "allow") {
        push({ type: "decision", outcome: "ok", reason: `${decision.reason} · ${lat.total}ms` });
        await sleep(180);
        const payload = emitResult(cap, who, "ok");
        record({ ...base, outcome: "ok", result: payload, reason: decision.reason });
        return;
      }
      if (decision.kind === "deny") {
        push({ type: "decision", outcome: "denied", reason: `${decision.reason} · ${lat.total}ms` });
        bump("denied");
        record({ ...base, outcome: "denied", result: null, reason: decision.reason });
        return;
      }
      // needs_approval — pause and hand it to the human playing admin.
      push({ type: "decision", outcome: "approved", reason: decision.reason });
      push({ type: "note", text: "Destructive + ungranted → routed to approval. You're the admin: approve or deny below.", tone: "warn" });
      const approved = await new Promise<boolean>((resolve) => {
        approvalResolve.current = resolve;
        setPending({ principal: who, cap });
      });
      setPending(null);
      approvalResolve.current = null;
      if (approved) {
        push({ type: "decision", outcome: "approved", reason: `human approved once · ${cap.name}` });
        await sleep(180);
        const payload = emitResult(cap, who, "approved");
        record({ ...base, outcome: "approved", result: payload, reason: "human approved once" });
      } else {
        push({ type: "decision", outcome: "denied", reason: `human denied the escalation · ${cap.name}` });
        bump("denied");
        record({ ...base, outcome: "denied", result: null, reason: "human denied the escalation" });
      }
    },
    [push, streamPhases, emitResult, record],
  );

  const fire = useCallback(
    async (cap: SimCapability, who: SimPrincipal = principal) => {
      if (busy) return;
      setBusy(true);
      try {
        await runCall(who, cap);
      } finally {
        setBusy(false);
        inputRef.current?.focus();
      }
    },
    [busy, principal, runCall],
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const typed = input.trim();
    if (!typed || busy) return;
    setInput("");
    const cap = CAP_BY_NAME[typed] ?? CAP_BY_NAME[typed.replace(/\(\)$/, "")];
    if (!cap) {
      push({ type: "cmd", principal: principal.name, cap: typed });
      push({ type: "decision", outcome: "error", reason: `unknown tool "${typed}" — try one from the palette` });
      record({ principal: principal.name, capability: typed, riskTier: null, outcome: "error", latencyMs: null, result: null, reason: "unknown tool" });
      return;
    }
    void fire(cap);
  };

  const surprise = () => {
    if (busy) return;
    const who = PRINCIPALS[seqRef.current % PRINCIPALS.length];
    const cap = CAPABILITIES[(seqRef.current * 7 + 3) % CAPABILITIES.length];
    setPrincipal(who);
    void fire(cap, who);
  };

  // A short scripted run that shows all three outcomes back to back, so a first-time visitor sees
  // what the sandbox does without having to know the vocabulary yet.
  const autoDemo = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const script: [string, string][] = [
        ["ci-deploy-bot", "github.create_issue"],
        ["intern-agent", "slack.post_message"],
        ["data-analyst", "postgres.query"],
        ["ci-deploy-bot", "postgres.drop_table"],
      ];
      // Sequential reduce rather than a for-loop: each call must fully resolve before the next,
      // and this keeps the awaits out of a loop body (no-await-in-loop).
      await script.reduce(async (prev, [pid, cname]) => {
        await prev;
        const who = PRINCIPALS.find((p) => p.id === pid)!;
        setPrincipal(who);
        await runCall(who, CAP_BY_NAME[cname]);
        await sleep(320);
      }, Promise.resolve());
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }, [busy, runCall]);

  const resolveApproval = (approved: boolean) => approvalResolve.current?.(approved);

  const clear = () => {
    setLines([{ id: nextId(), type: "note", text: "cleared.", tone: "dim" }]);
    setStats({ allowed: 0, denied: 0, approved: 0 });
    setEvents([]);
  };

  const buckets = useMemo(() => bucketize(events, now), [events, now]);
  const shownEvents = useMemo(
    () => (onlyProblems ? events.filter((e) => e.outcome === "denied" || e.outcome === "error") : events),
    [events, onlyProblems],
  );

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Sandbox</h1>
          <p>
            Fire pretend MCP tool calls at a pretend agent and watch the windrow broker allow, deny
            or escalate each one — live. <strong>It all runs in your browser</strong>; nothing here
            reaches a server or changes any data.
          </p>
        </div>
      </div>

      <div className="pg-layout">
        <div className="pg-terminal card">
          <div className="pg-termbar">
            <span className="pg-dots" aria-hidden="true">
              <i /><i /><i />
            </span>
            <span className="pg-termtitle">windrow://sandbox</span>
            <span className="pg-counts">
              <em className="ok">{stats.allowed} allowed</em>
              <em className="approved">{stats.approved} approved</em>
              <em className="denied">{stats.denied} denied</em>
            </span>
          </div>

          <div className="pg-scroll" ref={scrollRef}>
            {lines.map((l) => (
              <TermLine key={l.id} line={l} />
            ))}
            {busy && !pending && (
              <div className="pg-line pg-thinking">
                <span className="pg-spark" aria-hidden="true" />
                broker evaluating…
              </div>
            )}
            {pending && (
              <div className="pg-approval">
                <div className="pg-approval-text">
                  <strong>Approval required.</strong> {pending.principal.name} wants{" "}
                  <code>{pending.cap.name}</code> ({riskLabel(pending.cap.riskTier).toLowerCase()}).
                </div>
                <div className="pg-approval-actions">
                  <button className="btn btn-primary" onClick={() => resolveApproval(true)}>
                    Approve once
                  </button>
                  <button className="btn" onClick={() => resolveApproval(false)}>
                    Deny
                  </button>
                </div>
              </div>
            )}
          </div>

          <form className="pg-prompt" onSubmit={handleSubmit}>
            <span className="pg-prompt-head">
              {principal.name}
              <span className="pg-caret">$</span>
            </span>
            <input
              ref={inputRef}
              className="pg-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="type a tool, e.g. github.create_issue — or click one on the right"
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
            />
            <button className="btn btn-primary pg-run" disabled={busy || !input.trim()}>
              Invoke
            </button>
          </form>

          <div className="pg-toolbar">
            <button className="pg-chip pg-chip-accent" onClick={autoDemo} disabled={busy}>
              ▶ Auto-demo
            </button>
            <button className="pg-chip" onClick={surprise} disabled={busy}>
              🎲 Surprise me
            </button>
            <button className="pg-chip" onClick={clear} disabled={busy}>
              Clear
            </button>
          </div>
        </div>

        <aside className="pg-side">
          <div className="card pg-agents">
            <h2>Agent</h2>
            <div className="pg-agent-list">
              {PRINCIPALS.map((p) => (
                <button
                  key={p.id}
                  className={"pg-agent" + (p.id === principal.id ? " active" : "")}
                  onClick={() => setPrincipal(p)}
                  disabled={busy}
                >
                  <span className="pg-agent-name">
                    {p.name}
                    {p.pending && <span className="pg-tag pending">pending</span>}
                    <span className={"pg-tag kind-" + p.kind}>{p.kind}</span>
                  </span>
                  <span className="pg-agent-blurb">{p.blurb}</span>
                  <span className="pg-agent-grants">
                    {p.grants.length ? `${p.grants.length} grants` : "no grants"}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="card pg-tools">
            <h2>Tool calls</h2>
            <p className="muted pg-tools-hint">Click to fire it as {principal.name}. Grants held by this agent are lit.</p>
            <div className="pg-tool-list">
              {CAPABILITIES.map((c) => {
                const granted = principal.grants.includes(c.id);
                return (
                  <button
                    key={c.id}
                    className={"pg-tool risk-" + c.riskTier + (granted ? " granted" : "")}
                    onClick={() => void fire(c)}
                    disabled={busy}
                    title={c.description}
                  >
                    <span className="pg-tool-name">{c.name}</span>
                    <span className={"pg-risk risk-" + c.riskTier}>{riskLabel(c.riskTier)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>
      </div>

      {/* CALLS OVER TIME — the same chart the Fleet events page draws, on the calls you fire here.
          One-minute buckets over a rolling 20-minute window that scrolls as the clock ticks, so an
          empty sandbox still reads as a live tail rather than a broken one. */}
      <div className="card pg-chartcard">
        <h2>
          Calls over time <span className="muted">calls vs. denied, per minute</span>
        </h2>
        <LineChart data={buckets} granularity="minute" />
      </div>

      {/* EVENTS LOG — the tail of resolved calls, newest first, the way /fleet/events tails the real
          fleet. Fed entirely by this page's own simulated broker. */}
      <div className="card">
        <div className="pg-log-head">
          <h2>Events log</h2>
          <button
            type="button"
            className={"tab" + (onlyProblems ? " active" : "")}
            aria-pressed={onlyProblems}
            onClick={() => setOnlyProblems((v) => !v)}
          >
            Denied or errored
          </button>
        </div>
        {shownEvents.length === 0 ? (
          <div className="empty-state">
            {events.length === 0
              ? "No calls yet — fire one above and it lands here."
              : "Nothing denied or errored in the calls so far."}
          </div>
        ) : (
          <table className="event-table pg-log-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Principal</th>
                <th>Capability</th>
                <th>Risk</th>
                <th>Outcome</th>
                <th>Latency</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {shownEvents.map((e) => (
                <tr key={e.id}>
                  <td className="muted tabular">{clockTime(e.ts)}</td>
                  <td>
                    <code>{e.principal}</code>
                  </td>
                  <td>
                    <code>{e.capability}</code>
                  </td>
                  <td>
                    {e.riskTier ? (
                      <span className={`badge badge-${e.riskTier}`}>{riskLabel(e.riskTier)}</span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${OUTCOME_TONE[e.outcome]}`}>{OUTCOME_LABEL[e.outcome]}</span>
                  </td>
                  <td className="muted tabular">{e.latencyMs === null ? "—" : `${e.latencyMs} ms`}</td>
                  <td className="muted pg-log-result">
                    <code>{summarize(e)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function TermLine({ line }: { line: Line }) {
  switch (line.type) {
    case "note":
      return <div className={"pg-line pg-note" + (line.tone === "warn" ? " warn" : "")}>{line.text}</div>;
    case "cmd":
      return (
        <div className="pg-line pg-cmd">
          <span className="pg-cmd-head">{line.principal}</span>
          <span className="pg-caret">$</span>
          <span className="pg-cmd-tool">{line.cap}</span>
        </div>
      );
    case "phase":
      return <div className="pg-line pg-phase">├─ {line.text}</div>;
    case "decision":
      return (
        <div className={"pg-line pg-decision out-" + line.outcome}>
          <span className="pg-verdict">{OUTCOME_LABEL[line.outcome]}</span>
          <span className="pg-reason">{line.reason}</span>
        </div>
      );
    case "result":
      return (
        <div className="pg-line pg-result">
          <span className="pg-result-arrow">└─ result</span>
          <code>{formatPayload(line.payload)}</code>
        </div>
      );
  }
}

function formatPayload(payload: Record<string, unknown>): string {
  return (
    "{ " +
    Object.entries(payload)
      .map(([k, v]) => `${k}: ${typeof v === "string" ? `"${v}"` : String(v)}`)
      .join(", ") +
    " }"
  );
}
