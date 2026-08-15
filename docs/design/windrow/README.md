# windrow frontend redesign — reasoning

**Ask:** redesign the Windrow dashboard's frontend with a modern, sleek aesthetic
matching the host platform's look.

**Context found:** `client/` is a React + Vite app (Catalog, Principals, Grants, Dashboard, Fleet,
Docs pages) with an existing, disciplined light/dark token system in `client/src/styles/theme.css` —
warm-neutral surfaces, a single reserved accent blue, a fixed status/series palette documented as
coming from a dataviz-skill reference. The current look is clean but flat: 6px radii, hairline
borders, no shadow, `system-ui` everywhere, plain text-color active nav state.

**No bound Claude Design system was available for the host platform's look itself** — this run couldn't
open the platform's own UI as a design system. The direction below is a stated assumption, derived from
how the platform describes itself throughout this repo: a dark spatial canvas holding
cards, each with a colored state dot (done/active/blocked/design), portraits, wires between
related cards, monospace ids. That reads as: dark-first surface, one glowing accent, monospace for
technical/tabular content, generous rounded corners, soft elevation instead of hard borders.

**What carries over untouched:** all layout (grids, table structure, filter rows), all component
logic, and the existing status/series color palette — those are already correct and unrelated to
"modern and sleek." This redesign only touches surface color, radius, shadow, type, and the accent
treatment.

**Options not explored:** a full spatial/canvas rework of the shell (e.g., pages as draggable cards
on a canvas, mirroring the platform's own spatial-canvas metaphor) — that would be a UX change, not a
reskin, and this app's job (dense tabular usage data) doesn't obviously benefit from a spatial
layout. Flagged as a possible follow-up, not applied.

See [HANDOFF.md](./HANDOFF.md) for the file-by-file change list and token table.

## Addendum — the logomark (this pass)

**Ask:** the prior pass above restyled chrome (color, type, radius, shadow) but left the actual
brand mark unsolved — it swapped the wind-gust `brand-icon` SVG in `Layout.tsx` for an unlabeled
gradient square. That's a naming problem, not a polish problem: "Windrow" names the *trail* left
behind a pass across a field (raked hay, leaves, snow), and the old mark — three curved strokes of
shrinking width, all starting from one point — draws moving air, the opposite of what the name means.

**Context found:** the mark appears in exactly two places in the shipped app — `Layout.tsx`'s nav
brand SVG and `index.html`'s inline data-URI favicon — both holding the same 3-path geometry. No
other logo/wordmark instances exist in `client/src`.

**Directions explored:** 3, scored on one question — does the geometry read as "a row of material
trailing off" rather than "curling/puffing air"? Closed loops (curls, spirals) were the main risk,
since the *old* mark already used small arc-curls and a near-identical replacement wouldn't fix
anything. Picked the one direction with zero closed loops: three tapering wedges, literally shaped
like a row of raked material that runs out at one end. Full comparison and reasoning per option is
in [HANDOFF.md § Logomark](./HANDOFF.md#logomark--the-windrow-mark).

**What carries over untouched:** the dark-theme token set, type pairing, and nav-pill structure
from the earlier pass — the new mark drops into the existing `.brand .mark` 22px box with no layout
changes, and reuses `--accent`/`--cyan` rather than introducing new color tokens.

**What I couldn't finish in this pass:** Claude Design write access was interrupted mid-session
(`no active grant for mcp_tool "write_files"` on every retry) after the concepts mockup was
already published, so the *main* redesign mockup (`Capability Governance Redesign.dc.html`) still
shows the old gradient-square placeholder rather than the real mark — only
`Logomark Concepts.dc.html` reflects it. The HANDOFF file-by-file table is unaffected by this; it
describes the real codebase change either way.

## Addendum 2 — round 2, monochrome (this pass)

**Ask:** "go more minimal with the windrow logomark design — no colors."

**What changed:** dropped the `--accent`→`--cyan` two-tone tint entirely and redrew the picked
direction (round 1's "raked rows") as a single `currentColor` stroke — no fill, no gradient, no
opacity steps standing in for color either. Also swapped the tapered organic wedge shapes for
straight parallel line strokes: fewer curve points reads as more minimal on its own, and holds up
better at 16px favicon size where a thin curved taper tends to blur.

**Two other minimal directions considered and set aside:** a monochrome *fill* version of the
original wedge shapes (kept the curves, just recolored — read less minimal than straight strokes);
and a single-line-plus-two-dashes version (fewest strokes of the three, but weakened the "row/trail"
reading down to something closer to a generic 3-bar glyph). Both are shown alongside the pick in
`Logomark Concepts.dc.html`.

**What carries over from round 1:** the underlying concept (parallel marks, shortening
left→right to suggest a row running out, diagonal to imply one directional pass) — only the
color and shape treatment changed, not the idea. `docs/design/windrow/HANDOFF.md` § Logomark
now documents round 2 as the current spec; round 1's colored version is kept on the mockup page
for reference but is no longer the recommendation.

**Still unresolved from Addendum 1:** the Claude Design write-access interruption is unchanged —
the main redesign mockup file still shows the old placeholder. `Logomark Concepts.dc.html` was
still writable and now shows round 2.
