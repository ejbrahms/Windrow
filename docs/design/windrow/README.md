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

## Addendum 3 — left sidebar nav + strict minimal palette

**Ask:** two requirements on top of everything above. First, move the nav from the top pill bar to
a collapsible left sidebar — icon-only when collapsed with hover tooltips, icon + label when
expanded, defaulting to expanded and persisting the user's choice, with the main content getting a
left inset instead of a top one. Second, tighten the palette rule beyond the existing monochrome
pass: at most 1-2 accent colors anywhere in the UI (grayscale + the functional status/series
colors + the logomark's own accent stay exempt), and remove every remaining glow, box-shadow halo,
gradient, or blur — not just the ones the first monochrome pass already caught in the top nav.

**What changed:** the sidebar reuses the same components (brand mark, `SettingsMenu`, GitHub link,
`ThemeToggle`) just relocated — nothing about their internal logic changes, only their container
and, for the settings trigger, whether a text label renders alongside the icon. Docs moves from the
`SettingsMenu` dropdown to a top-level sidebar item, since the requirement's page list names it
explicitly alongside Catalog/Principals/Grants/Dashboard/Fleet. Collapse state persists the same way
theme preference already does — `localStorage`, read once on mount, no new persistence pattern.
The audit for glow/gradient/blur went further than the sidebar itself: it also caught the top bar's
`backdrop-filter: blur`, the card drop-shadow's blur layer, the settings-dropdown shadow, and the
toggle-switch thumb shadow — none of those were flagged in the original "more minimal, no colors"
pass because that pass was scoped to *color*, not to shadow/blur as a category. This pass treats
"no glow, no halos, no gradients, no blur" as its own rule, separate from and stricter than "no
extra hues," and applies it everywhere, not just in the nav.

**What carries over untouched:** the dark-first token set, type pairing, the badge/status/series
color exception, and the logomark's own accent+cyan fill as the sole deliberate brand exception —
none of that is reopened by either the sidebar move or the shadow/blur cleanup. Every page's grid
layout is also untouched; only the ancestor claiming layout space changed from a top bar to a left
column, which is a different axis of the same "ancestor claims space, `.page` fills the rest"
mechanism already in place.

**What I couldn't finish in this pass:** the same Claude Design write-access interruption noted in
Addendum 1 recurred — `write_files` returned `no active grant for mcp_tool "write_files"` on every
retry against this project, so the new mockup (`Left Sidebar Nav.dc.html`) is written correctly at
`docs/design/windrow/exports/` but isn't yet live on the hosted project page. See
[HANDOFF.md § Addendum 3](./HANDOFF.md#addendum-3--left-sidebar-nav--strict-minimal-palette) for
the full file-by-file spec and the before/after audit table — that content is unaffected by the
publish failure, same as Addendum 1's note.

## Addendum 4 — 5 fresh logomark options — **2a picked**

**Ask:** the logomark still hasn't shipped — every addendum above kept hitting the write-access
interruption before the mark could be applied to `Layout.tsx`/`index.html`, so the app still shows
the original wind-gust icon. This pass is a fresh request for 5 new trail/row concepts (not a
retry of round 1's 1a/1b/1c).

**What changed:** 5 new directions — 2a Raked Furrows, 2b Windrow Ridges (monochrome), 2c Swept
Pile, 2d Trail Dashes, 2e Comb Rake — all straight-edged (no arcs/curls, unlike the shipped mark
and round 1's rejected 1b/1c), each shown at 76px detail, real 24px nav size, and real 16px
favicon size in `docs/design/windrow/exports/Logomark Options.dc.html`. One (2b) is pure monochrome per
the strict-minimal-palette constraint; the other four use `--accent`/`--cyan`, 1-2 colors each.
**The human picked 2a — Raked Furrows** (3 tapered diagonal bars of decreasing length,
`--accent`/`--cyan`), replacing round 1's 1a as the current spec.

**What carries over untouched:** the "trail not wind" test from round 1 — no closed loop/curl — and
the logomark-as-sole-exception rule from Addendum 3's strict palette pass. Only the geometry
directions are new.

**Still unresolved:** the actual code swap in `Layout.tsx`/`index.html` — this design loom doesn't
touch `src/`, so applying 2a's markup (in HANDOFF.md's file-by-file table) is the next step for an
implementer. See
[HANDOFF.md § Addendum 4](./HANDOFF.md#addendum-4--5-new-logomark-options--2a-picked) for the
full comparison table, SVG markup for all 5, and the ready-to-apply file table for 2a.
