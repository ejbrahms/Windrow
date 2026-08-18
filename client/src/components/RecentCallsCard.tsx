import { useMemo, useState } from "react";
import type { UsageEvent, UsageOutcome } from "../api/types";

function ms(n: number | null): string {
  return n === null ? "—" : `${Math.round(n)}ms`;
}

type OutcomeTab = "all" | UsageOutcome;

const TABS: { value: OutcomeTab; label: string }[] = [
  { value: "all", label: "All" },
  { value: "ok", label: "Allowed" },
  // "approved" (F3, docs/design/governance-review-2026-08-16.md): a destructive call that was
  // initially denied (no grant) and then approved via the harness's own ask prompt — distinct
  // from "ok" (an active grant covered it from the start), so it gets its own tab rather than
  // being folded into either "Allowed" or "Denied".
  { value: "approved", label: "Approved (ask)" },
  { value: "denied", label: "Denied" },
  { value: "error", label: "Errors" },
];

interface Props {
  events: UsageEvent[] | null | undefined;
  principalNameById: Map<string, string>;
  capabilityNameById: Map<string, string>;
}

// Recent calls, split into per-outcome tabs so a busy log doesn't bury the handful of denials or
// errors under a wall of routine allowed calls — plus a free-text filter over principal/capability.
const PAGE_SIZE = 20;

export function RecentCallsCard({ events, principalNameById, capabilityNameById }: Props) {
  const [tab, setTab] = useState<OutcomeTab>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);

  const counts = useMemo(() => {
    const c: Record<OutcomeTab, number> = { all: 0, ok: 0, approved: 0, denied: 0, error: 0 };
    for (const e of events ?? []) {
      c.all++;
      c[e.outcome]++;
    }
    return c;
  }, [events]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (events ?? []).filter((e) => {
      if (tab !== "all" && e.outcome !== tab) return false;
      if (!needle) return true;
      const principal = (principalNameById.get(e.principalId) ?? e.principalId).toLowerCase();
      const capability = (capabilityNameById.get(e.capabilityId) ?? e.capabilityId).toLowerCase();
      const host = (e.hostname ?? "").toLowerCase();
      const osUser = (e.osUser ?? "").toLowerCase();
      return (
        principal.includes(needle) ||
        capability.includes(needle) ||
        host.includes(needle) ||
        osUser.includes(needle)
      );
    });
  }, [events, tab, search, principalNameById, capabilityNameById]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageEvents = useMemo(
    () => filtered.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE),
    [filtered, clampedPage]
  );

  function selectTab(t: OutcomeTab) {
    setTab(t);
    setPage(0);
  }

  function updateSearch(value: string) {
    setSearch(value);
    setPage(0);
  }

  return (
    <div className="card">
      <h2>
        Recent calls <span className="muted">who issued each one, and from which computer</span>
      </h2>

      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            className={"tab" + (tab === t.value ? " active" : "")}
            onClick={() => selectTab(t.value)}
          >
            {t.label} <span className="tab-count">{counts[t.value]}</span>
          </button>
        ))}
        <input
          className="tab-search"
          type="text"
          placeholder="Filter by principal, capability, host…"
          value={search}
          onChange={(e) => updateSearch(e.target.value)}
        />
      </div>

      {!events || events.length === 0 ? (
        <div className="empty-state">No calls recorded yet.</div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">No calls match this filter.</div>
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Principal</th>
                <th>OS user</th>
                <th>Computer</th>
                <th>Capability</th>
                <th>Outcome</th>
                <th>Total latency</th>
              </tr>
            </thead>
            <tbody>
              {pageEvents.map((e) => (
                <tr key={e.id}>
                  <td className="muted">{new Date(e.ts).toLocaleString()}</td>
                  <td>{principalNameById.get(e.principalId) ?? e.principalId}</td>
                  <td>{e.osUser ?? <span className="muted">—</span>}</td>
                  <td className="muted">{e.hostname ?? "—"}</td>
                  <td>{capabilityNameById.get(e.capabilityId) ?? e.capabilityId}</td>
                  <td>
                    <span className={`badge badge-${e.outcome}`}>{e.outcome}</span>
                  </td>
                  <td className="muted tabular">{ms(e.latencyMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {pageCount > 1 && (
            <div className="pagination">
              <button
                type="button"
                className="pagination-btn"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={clampedPage === 0}
              >
                Previous
              </button>
              <span className="muted pagination-status">
                Page {clampedPage + 1} of {pageCount}
              </span>
              <button
                type="button"
                className="pagination-btn"
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={clampedPage >= pageCount - 1}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
