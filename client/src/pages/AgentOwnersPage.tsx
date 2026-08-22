import { OwnerProposalsCard } from "../components/OwnerProposalsCard";

/**
 * Agent → person, proposed from usage and confirmed by hand
 * (docs/design/global-identity-and-central-db.md §1.6).
 *
 * Lives under Security rather than on the Overview because it is an accountability question, not
 * a usage metric: an unowned agent is a gap in who answers for the calls, which is the same kind
 * of question as Hook Integrity and Approvals, and it needs deciding rather than watching.
 */
export function AgentOwnersPage() {
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Agent owners</h1>
          <p>
            Which person each agent belongs to, proposed from the OS account its calls were made
            under. Nothing here is applied until you confirm it — the evidence sits next to the
            suggestion because the reasons to disagree are all in the denominator.
          </p>
        </div>
      </div>

      <OwnerProposalsCard />
    </div>
  );
}
