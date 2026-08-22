# Design notes

The decision record: why the code is shaped the way it is. These are **explanation**, not
instructions — [setup](../setup.md) tells you how to run Windrow, and these tell you why running it
that way is the shape it is.

Source files cite these notes by name, and several cite them by section or finding number, so they
are part of how the code explains itself rather than a parallel archive.

## Architecture

| Note | What it settles |
|---|---|
| [`global-identity-and-central-db.md`](global-identity-and-central-db.md) | The two-host architecture and the Postgres schema |
| [`deployment-boundary-decision.md`](deployment-boundary-decision.md) | Per-workspace vs. one shared server, and why this machine runs shared |
| [`per-node-enrollment-credentials.md`](per-node-enrollment-credentials.md) | What a credential is, what it authorises, and why the CA lives on central |
| [`setup-after-central.md`](setup-after-central.md) | Assembling a two-host fleet |
| [`cross-field-and-standalone.md`](cross-field-and-standalone.md) | Attributing usage with no platform agent id |

## Enforcement

| Note | What it settles |
|---|---|
| [`dashboard-placement.md`](dashboard-placement.md) | Whether the dashboard belongs on each node or on central — **open, conflicts with `dashboard-hosting-decision.md`** |
| [`unified-interception.md`](unified-interception.md) | One policy core, three backend adapters |
| [`grant-resolution-semantics.md`](grant-resolution-semantics.md) | How a grant is matched to a call |
| [`enforcement-pause.md`](enforcement-pause.md) | The signed, time-boxed debugging window |
| [`upgrade-resilience.md`](upgrade-resilience.md) | Restarts, grace leases, and why the supervisor holds the port |
| [`latency-breakdown.md`](latency-breakdown.md) | Where the milliseconds go, measured rather than guessed |
| [`native-tool-observability.md`](native-tool-observability.md) | Recording native tool calls that no grant governs |

## Catalog and providers

| Note | What it settles |
|---|---|
| [`adding-a-provider.md`](adding-a-provider.md) | What it takes to support another agent backend |
| [`agy-adapter.md`](agy-adapter.md) | Antigravity's hook contract, and what is unverified |
| [`skill-mcp-governance.md`](skill-mcp-governance.md) | Why skills are catalogued but not gated |
| [`capability-packages.md`](capability-packages.md) | Grouping capabilities into grantable units |
| [`api-contract.md`](api-contract.md) | The routes hooks depend on |

## Point-in-time records

These describe the system **as it was on a date**, not as it is now. Read them as history rather
than as current documentation.

| Note | Status |
|---|---|
| [`integration-todo.md`](integration-todo.md) | The numbered plan the code cites as "step N"; open items live in the [issue tracker](https://github.com/ejbrahms/Windrow/issues) |
| [`governance-to-windrow-rename.md`](governance-to-windrow-rename.md) | Complete; kept only because `envCompat` still refuses the old names |

> [!note]
> A superseded decision record is worth keeping. It explains why the code looked the way it did at
> the commit that cites it — delete it and the comment pointing at it becomes a dead reference.
> Mark it superseded and link forward instead.

## Not in this repository

Security reviews and audits are **deliberately gitignored** (`.gitignore`) and stay on the
maintainer's machine: they describe attack shapes against a specific commit, and several findings
are open. Report a vulnerability through [`SECURITY.md`](../../SECURITY.md); fixed issues are
published as GitHub Security Advisories.

The controls those reviews prompted are described where they live — in the code comments and in the
notes above — rather than by citing a document a reader of this repository cannot open.
