# windrow frontend redesign — reasoning

**Ask:** redesign the Capability Governance dashboard's frontend with a modern, sleek aesthetic
matching Wispfield's look.

**Context found:** `client/` is a React + Vite app (Catalog, Principals, Grants, Dashboard, Fleet,
Docs pages) with an existing, disciplined light/dark token system in `client/src/styles/theme.css` —
warm-neutral surfaces, a single reserved accent blue, a fixed status/series palette documented as
coming from a dataviz-skill reference. The current look is clean but flat: 6px radii, hairline
borders, no shadow, `system-ui` everywhere, plain text-color active nav state.

**No bound Claude Design system was available for "Wispfield's look" itself** — this run couldn't
open Wispfield's own UI as a design system. The direction below is a stated assumption, derived from
how Wispfield describes itself throughout this repo: a dark spatial canvas ("the field") holding
cards ("looms"), each with a colored state dot (done/active/blocked/design), portraits, wires between
related cards, monospace ids. That reads as: dark-first surface, one glowing accent, monospace for
technical/tabular content, generous rounded corners, soft elevation instead of hard borders.

**What carries over untouched:** all layout (grids, table structure, filter rows), all component
logic, and the existing status/series color palette — those are already correct and unrelated to
"modern and sleek." This redesign only touches surface color, radius, shadow, type, and the accent
treatment.

**Options not explored:** a full spatial/canvas rework of the shell (e.g., pages as draggable cards
on a canvas, mirroring Wispfield's literal field metaphor) — that would be a UX change, not a
reskin, and this app's job (dense tabular usage data) doesn't obviously benefit from a spatial
layout. Flagged as a possible follow-up, not applied.

See [HANDOFF.md](./HANDOFF.md) for the file-by-file change list and token table.
