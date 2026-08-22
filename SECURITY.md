# Security policy

## Reporting a vulnerability

Please report security issues through GitHub's
[private vulnerability reporting](https://github.com/ejbrahms/Windrow/security/advisories/new)
rather than opening a public issue.

Include what you were running (node, central, or both), the version or commit, and enough detail to
reproduce. You will get an acknowledgement within a few days.

Fixed issues are published as GitHub Security Advisories with the fix linked.

## Scope

Windrow is an enforcement layer, so the interesting boundaries are worth naming explicitly.

| Boundary | Expectation |
|---|---|
| `:4000` plaintext listener | Loopback only, `agent` scope only. Admin authority must never travel over it |
| `:4443` / `:5443` mTLS | A valid enrolled client certificate is required; an unknown serial is refused, not allowed |
| The enrollment CA | One key, one place. It can mint an admin certificate for any node id in the fleet |
| The hook adapters | A fault must not silently become an allow on a mutating or destructive call |
| Grace leases and enforcement pauses | Time-boxed and signed by a healthy server; never openable by the hook itself |

Reports that a *fault* fails closed, or that a paused window allows calls it says it allows, are
working as designed — see [`docs/architecture.md`](docs/architecture.md#decisions-not-denials) and
[`docs/design/enforcement-pause.md`](docs/design/enforcement-pause.md).

## Known development-only affordances

These are deliberate, documented, and off by default. They are not vulnerabilities, but they are
worth knowing before you deploy.

- **`WINDROW_CENTRAL_ALLOW_INSECURE=1`** opens a loopback plaintext listener on central. A batch
  arriving there is attributed to whatever node id it claims, because there is no certificate to
  check it against. Development only.
- **The Vite dev proxy** on `:5173` presents an admin client certificate on the browser's behalf and
  performs no authentication of its own, so any local process can reach the API with admin rights
  while it is running. Do not leave it up on a shared machine.
