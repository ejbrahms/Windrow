import { useState } from "react";
import type { ReactNode } from "react";
import type { FleetEvent } from "../api/fleet";
import { JsonView } from "./JsonView";

/**
 * THE EVENT DRAWER, AND THE ROW MACHINERY AROUND IT — shared, because the same governed decision is
 * listed in more than one place and the second copy of a table is where two views of one row start
 * disagreeing. The fleet Events tail and one node's "most recent events" table read the same
 * `FleetEvent` shape from the same route; before this file the tail could be expanded and the
 * node-detail table could not, so "why was this denied" was answerable on one page and not on the
 * structurally identical other one.
 *
 * WHAT THE DRAWER IS FOR. The table columns are the summary; everything that makes a row
 * *accountable* — the reason text, where the latency actually went, the actor snapshot the hook
 * captured at call time, and the payload digest fields as the node hashed them — is too wide for a
 * column and too important to drop. It goes here, one row down, on demand.
 */

const ms = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `${n.toLocaleString()} ms`;

/** The latency phases central stores beside the total, drawn only when at least one was recorded. A
 *  phase that is null on this build is skipped rather than shown as 0 — §2.6, absent is not zero. */
const PHASES: { key: keyof FleetEvent; label: string }[] = [
  { key: "capabilityLookupMs", label: "Capability lookup" },
  { key: "principalResolveMs", label: "Principal resolve" },
  { key: "grantCheckMs", label: "Grant check" },
  { key: "brokerMs", label: "Broker" },
];

/** The actor snapshot the hook captured at call time — who and where, kept verbatim so a row stays
 *  attributable even after the loom is gone. Empty fields are dropped from the grid. */
const ACTOR_FIELDS: { key: keyof FleetEvent; label: string }[] = [
  { key: "actorLoomId", label: "Loom" },
  { key: "actorAgentType", label: "Agent type" },
  { key: "actorBackend", label: "Backend" },
  { key: "actorField", label: "Field" },
  { key: "osUser", label: "OS user" },
  { key: "hostname", label: "Hostname" },
  { key: "subjectId", label: "Subject" },
  { key: "correlationId", label: "Correlation" },
  { key: "incarnation", label: "Incarnation" },
];

export function EventDrawer({ e, colSpan }: { e: FleetEvent; colSpan: number }) {
  const phases = PHASES.filter((p) => e[p.key] !== null && e[p.key] !== undefined);
  const actor = ACTOR_FIELDS.filter((f) => e[f.key] !== null && e[f.key] !== undefined && e[f.key] !== "");
  return (
    <DrawerRow colSpan={colSpan}>
      <section>
        <h3>Reason</h3>
        <p className={e.reason ? "" : "muted"}>{e.reason ?? "No reason recorded."}</p>
      </section>

      <section>
        <h3>
          Phases <span className="muted">where the {ms(e.latencyMs)} went</span>
        </h3>
        {phases.length === 0 ? (
          <p className="muted">No per-phase timing recorded for this call.</p>
        ) : (
          <dl className="event-phase-grid">
            {phases.map((p) => (
              <div key={p.key}>
                <dt>{p.label}</dt>
                <dd className="tabular">{ms(e[p.key] as number)}</dd>
              </div>
            ))}
            <div>
              <dt>Total</dt>
              <dd className="tabular">{ms(e.latencyMs)}</dd>
            </div>
          </dl>
        )}
      </section>

      <section>
        <h3>Actor snapshot</h3>
        <dl className="event-actor-grid">
          {actor.map((f) => (
            <div key={f.key}>
              <dt>{f.label}</dt>
              <dd>
                <code>{String(e[f.key])}</code>
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="event-payload">
        <h3>
          Payload <span className="muted">extra fields, as the node hashed them</span>
        </h3>
        <JsonView source={e.extra} />
      </section>
    </DrawerRow>
  );
}

/** The `<tr>` a drawer lives in — one full-width cell, no row padding of its own. Exported so a
 *  table with a different payload (the fault journal's raw entry) gets the same panel chrome
 *  without restating the colSpan/class contract. */
export function DrawerRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr className="event-drawer-row">
      <td colSpan={colSpan}>
        <div className="event-drawer">{children}</div>
      </td>
    </tr>
  );
}

/** The leading cell that opens a row. The whole row is clickable too; this carries the accessible
 *  name and `aria-expanded`, so the control a screen reader finds is a real button rather than a
 *  `<tr>` with an onClick. `stopPropagation` keeps the button's own click from toggling twice. */
export function ExpanderCell({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <td className="event-expander">
      <button
        type="button"
        className="expander-btn"
        aria-label={open ? "Collapse detail" : "Expand detail"}
        onClick={(ev) => {
          ev.stopPropagation();
          onToggle();
        }}
      >
        <span className={"chevron" + (open ? " open" : "")}>▸</span>
      </button>
    </td>
  );
}

/** Which rows are open, keyed by whatever string the table considers a row's identity. A Set rather
 *  than a single id: expanding a second row must not collapse the first, since comparing two rows
 *  side by side is most of why the drawer exists. */
export function useExpandedRows() {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return { isOpen: (key: string) => expanded.has(key), toggle };
}
