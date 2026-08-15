# Handoff — Windrow frontend redesign

Mockup: `docs/design/windrow/Capability Governance Redesign.dc.html` (also live at
https://claude.ai/design/p/d8a0d808-18e1-4108-bb81-fd564078a702?file=Capability+Governance+Redesign.dc.html) —
file name kept as-is to match the hosted design link; the mockup's on-page brand text now reads
"Windrow".

**Logomark addendum:** the prior pass above left the brand mark as a generic gradient square
placeholder — it didn't solve what the mark should actually look like. See
[the "Logomark" section below](#logomark--the-windrow-mark) for the concept, the token/file changes
it needs, and the pick: **1a, colored** (raked-rows, tapered wedges, tinted `--accent`→`--cyan`).
Mockup: `docs/design/windrow/Logomark Concepts.dc.html` (also live at
https://claude.ai/design/p/d8a0d808-18e1-4108-bb81-fd564078a702?file=Logomark+Concepts.dc.html).
Shown at nav (24px) and large (88px) size — [reasoning below](#logomark--the-windrow-mark).
*Correction: a since-retracted "round 2" briefly redrew this mark monochrome — that was a
misapplication of the "go more minimal, no colors" feedback below, which was about the site's
chrome, not the logo. The logo is unchanged from its original pick.* The main redesign mockup
above still shows the gradient-square placeholder in its `.mark` span; a write-access interruption
mid-session has repeatedly stopped that file from being updated to the real SVG — that edit is a
direct copy of the `<svg>` markup below into the existing `.brand .mark` span, nothing else in
that file changes.

**Site-chrome addendum — "more minimal, no colors":** see
[§ Site chrome — monochrome](#site-chrome--monochrome) below. This strips the decorative
`--accent`/`--cyan` treatment (nav-pill glow, gradient button, stat-tile corner wash, colored
links, page-background color blobs) from the shell and replaces it with flat grayscale — while
leaving the badge/status color vocabulary alone, since those colors carry required meaning
(risk tier), not brand decoration.

**Assumption stated up front:** there is no shared design system for the host platform reachable
from this project, so "matches the platform's look" was interpreted from the visual vocabulary the
platform's own UI is described in throughout this repo's harness docs — a dark spatial canvas of
cards with colored state dots (done/active/blocked), soft glow accents, monospace
technical labels, generous rounded corners. If the real platform app uses a different palette,
swap the hex values in the token table below — the structure (dark-first, glow accent, mono for
data) carries either way.

## What changes, file by file

| File | Change |
|---|---|
| `client/src/styles/theme.css` | Replace `:root` token block with the dark-first palette below. Dark becomes the default `color-scheme`; light mode keeps today's warm-neutral values as the secondary theme, reachable via the existing `[data-theme="light"]` toggle — no changes needed to `useTheme.ts` or `ThemeToggle.tsx`, only the values each theme resolves to. |
| `client/src/styles/app.css` | `.topnav` → rebuild as the pill-nav bar (`.topbar` + `.navpill` in the mockup): sticky, blurred glass background, active link gets a raised chip (neutral border, no color) instead of colored text. `.card` gets `--radius-lg` (16px, up from 6px) and the two-layer shadow. `.stat-tile` drops its corner wash — flat surface only. `.badge::before` dot keeps its status color (unchanged) but loses the glow shadow. `.btn-primary` becomes a solid neutral ink-block fill (`--ink` on `--bg`) instead of a flat brand-color fill. `th` switches to the mono font. `a`/`a:hover` switch from accent-colored to neutral underline-driven links. See [§ Site chrome — monochrome](#site-chrome--monochrome) for the full before/after on every one of these. Everything else (grid layouts, table structure, filter row, dialog, chart CSS) is unchanged — only surface, radius, shadow, and accent-treatment values move. |
| `client/index.html` | Add the two Google Fonts `<link>` tags (Space Grotesk, IBM Plex Mono) — same ones in the mockup's `<helmet>`. Also replace the inline `<link rel="icon">` data-URI SVG — see [Logomark](#logomark--the-windrow-mark). |
| `client/src/components/Layout.tsx` | Swap the `<nav className="topnav">` markup for the brand-mark + pill-nav structure shown in the mockup (`<span className="brand">` gains the `.mark` span; links move inside a `.navpill` wrapper). Replace the existing `brand-icon` `<svg>` (the three shrinking curved strokes) with the new windrow mark — see [Logomark](#logomark--the-windrow-mark). No routing logic changes. |
| `client/src/components/Badge.tsx`, `StatTile.tsx` | No prop/logic changes — they already emit the classes app.css now restyles. |
| Every page under `client/src/pages/` | No structural changes — they consume `.card`, `.stat-tile`, `.badge`, `.filters`, table markup, all of which pick up the new look automatically once `theme.css`/`app.css` are updated. |

## Tokens

| Token | Dark (default) | Light (secondary theme, unchanged) |
|---|---|---|
| `--surface-page` / `--bg` | `#0a0a0d` | `#f9f9f7` (today's value) |
| `--surface-card` | `#131318` | `#fcfcfb` |
| `--surface-raised` | `#1a1a21` | `#ffffff` |
| `--ink` | `#f3f3f1` | `#0b0b0b` |
| `--ink-secondary` | `#a3a3ad` | `#52514e` |
| `--ink-muted` | `#6c6c78` | `#898781` |
| `--rule` | `rgba(255,255,255,.08)` | `#e1e0d9` |
| `--accent` | `#8b7cf6` | kept, but see below — no longer used by UI chrome as of this pass. Still the logo's own fill color (a brand mark, not a chrome decoration) and available for future functional use. |
| `--radius` | `16px` cards / `12px` tiles / `8px` controls (was flat `6px` everywhere) | same |

Status colors (`--status-good/warning/critical`) and series colors (`--series-1..4`) are untouched —
they're already a reserved, tested palette per the dataviz skill's palette reference. The badge dot
keeps its status color; it just lost its glow (see [§ Site chrome](#site-chrome--monochrome)).

- `--font-display` (Space Grotesk) — headings, brand mark, stat-tile values only. Body copy, table
  cells, and forms keep `system-ui` untouched — a data-dense app doesn't want a display font in
  running text.
- `--font-mono` swaps from the current `ui-monospace` stack to IBM Plex Mono for a consistent look
  across code blocks, table headers, and technical labels (ids, timestamps, kind pills).

`--accent-glow`, `--accent-soft`, and `--cyan` from the first pass are **retired as of this pass** —
they existed only to drive the nav-pill glow, button gradient, stat-tile wash, and bar-chart fills
that [§ Site chrome — monochrome](#site-chrome--monochrome) removes. Leave the token definitions in
place if useful for a future functional (non-decorative) need, but nothing in the shell should
reference them going forward.

## Logomark — the windrow mark

**Problem:** the shipped `brand-icon` in `Layout.tsx` is three curved horizontal strokes, each
shorter and thinner than the last, all starting at the same left edge — that's a puff-of-wind
glyph (moving air), not a windrow (the raked *row* material left behind a pass). The prior redesign
pass didn't fix this — it swapped the icon for an unmarked gradient square placeholder.

**3 directions explored** (`docs/design/windrow/Logomark Concepts.dc.html`):

| # | Direction | Why it does / doesn't read as "trail" |
|---|---|---|
| 1a **— picked** | Raked rows: 3 parallel diagonal wedges, wide at the start, tapering to a fine point where each row's material runs out, tinted `--accent`→`--cyan` | Tapering-to-a-point *is* what a windrow looks like at its end; diagonal + parallel implies one pass, not radiating air; no closed loops so it can't be misread as a curl/breeze mark |
| 1b | Furrow curl: 3 parallel strokes of uneven start, all curling into one shared spiral where material "piles" | Reads as trail + accumulation, but the curl geometry is close enough to the old wind-icon's loops to risk the same misreading at 24px |
| 1c | Wake chevrons: 3 `>`-shaped chevrons shrinking and trailing off | Reads as "path/progress" generically (breadcrumbs, forward arrows) more than "raked material" specifically — weakest fit for "windrow" |

**The mark (1a), as SVG** — `viewBox="0 0 24 24"`, three filled paths, no stroke:

```svg
<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M2,3.8 Q11,3.9 19.4,7.6 Q20.2,8 19.6,8.4 Q11,5.2 2,6.4 Z" fill="var(--accent)"/>
  <path d="M2,10.7 Q11,11.3 19.6,14.7 Q20.3,15.1 19.6,15.4 Q11,12.6 2,13.1 Z" fill="#a999f8"/>
  <path d="M2,16.9 Q9.5,17.6 16.8,20.1 Q17.5,20.4 16.9,20.7 Q9.5,18.7 2,18 Z" fill="var(--cyan)"/>
</svg>
```

| File | Change |
|---|---|
| `client/src/components/Layout.tsx` | Replace the `brand-icon` `<svg>` body (currently `<path d="M3 8h11a3 3 0 1 0-3-3" />` etc., 3 paths) with the 3 paths above. Keep `viewBox="0 0 24 24"` and `className="brand-icon"`; drop the `stroke`/`fill="none"` props on the `<svg>` itself since the new mark is filled, not stroked — set `fill="none"` still on the root (each `<path>` carries its own fill). |
| `client/src/styles/app.css` (or wherever `.brand-icon` is styled today) | If `.brand-icon` currently sets `stroke: currentColor`, remove it; add `.brand-icon path:nth-child(1) { fill: var(--accent); } .brand-icon path:nth-child(2) { fill: var(--accent); opacity: .8; } .brand-icon path:nth-child(3) { fill: var(--cyan); }` to match the mockup's two-accent tint. |
| `client/index.html` | Replace the inline `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,...">` data URI — same 3 `<path>`s as above, `fill="#8b7cf6"` / `"#a999f8"` / `"#4fd1e8"` baked in as literal hex (a data-URI favicon can't read CSS variables). URL-encode the same way the current one is encoded. |
| `client/public/` (new) | If the app gains a manifest/PWA icon set later, generate 32/180/512px PNG exports of this same mark rather than hand-drawing a separate icon — the geometry scales cleanly since it has no fine detail below the 24px original. Not needed for this pass; noted for follow-up. |

**Tokens** — no new tokens needed beyond what the dark-theme redesign already specced;
`--accent` (`#8b7cf6`) and `--cyan` (`#4fd1e8`) are reused as the mark's two fills. Note this is now
the *only* place those two tokens are used decoratively — see
[§ Site chrome — monochrome](#site-chrome--monochrome) for why the rest of the shell doesn't use
them. The favicon is the one place the mark's colors must be hardcoded as literal hex rather than
referenced as CSS variables, since `data:` URI SVGs render outside the page's stylesheet.

**What must NOT change:** the mark's `viewBox="0 0 24 24"` (matches the existing `brand-icon`
sizing in `Layout.tsx` and the nav's `22px` box in the mockup) — swapping the icon shouldn't require
touching the `.brand`/`.mark` layout CSS. The wordmark text "Windrow" next to it is unchanged. The
mark keeps its own accent/cyan color even though the rest of the chrome around it goes monochrome —
it's a brand mark, not a UI-state color, and is the one deliberate exception.

**How to tell it worked:** the nav mark reads as three tapering diagonal bars, not three arcing
lines of shrinking width — no visible curls/loops at either end. Browser tab favicon shows the same
three-bar shape at 16px and is still legible as three distinct bars (not a blur) at that size.

## Site chrome — monochrome

**Ask:** "go more minimal, no colors" — applied to the site's chrome, not the logo (a prior pass
mistakenly applied this to the logomark instead; that's reverted above). The first redesign pass
introduced `--accent` (purple) and `--cyan` as decorative UI-chrome colors: a glow behind the active
nav pill, a gradient fill on primary buttons, a radial color wash in the corner of every stat tile,
colored links, and two color blobs in the page background. None of that is functional — nothing
about those elements needs a hue to be understood — so this pass removes it and leans on contrast,
weight, and space instead, which is what "minimal" means for a dark, data-dense UI like this one.

**What's exempt and why:** the badge status colors (good/warning/critical) and chart series colors
are untouched — those *are* functional (risk tier, series identity), not decoration, and removing
them would remove information, not just a color. Same reasoning already applied to those in the
first pass; this pass doesn't reopen that call. The logomark also keeps its own accent/cyan fill —
see the note above.

| Element | Before (first pass) | After (this pass) |
|---|---|---|
| Active nav pill | Raised chip + colored glow (`box-shadow: 0 0 0 1px var(--rule-strong), 0 0 14px rgba(139,124,246,.18)`) | Raised chip, glow dropped: `box-shadow: 0 0 0 1px var(--rule-strong)` only |
| Primary button (`.btn-primary`) | Gradient fill `--accent` → `#6f5ff0`, transparent border, glow shadow | Solid ink-block fill: `background: var(--ink); color: var(--bg); border-color: transparent;` hover dims to `var(--ink-secondary)`. No glow. |
| Stat tile corner wash | `::after` radial gradient using `--accent-soft` | Removed — flat surface, no `::after` |
| Badge status dot | Status color + `box-shadow: 0 0 6px currentColor` glow | Same status color, glow dropped — flat dot |
| Links (`a`, `a:hover`) | `color: var(--accent)`, hover `var(--cyan)` | `color: var(--ink)`, `text-decoration: underline`, `text-decoration-color: var(--rule-strong)`; hover darkens the underline to `var(--ink)` |
| Page background | Dot-grid + two colored radial blobs (`rgba(139,124,246,.10)`, `rgba(79,209,232,.07)`) | Dot-grid only, both color blobs removed |
| Dashboard bar-chart fills (`.bar-fill`) | `var(--accent)` (principals card) / `var(--cyan)` (capabilities card) | `var(--ink-secondary)` on every bar — each card's bars are all one series already (the two cards aren't overlaid), so hue was never load-bearing there; rank is still readable from bar length + the `bar-value` number |

**Tokens:** no new tokens. `--accent-glow`, `--accent-soft`, and the UI use of `--cyan` are retired
(see the Tokens section above) — nothing in `app.css` should reference them after this change,
though the definitions can stay in `theme.css` since the logomark still uses `--accent`/`--cyan`
directly.

**What must NOT change:** layout, radius, shadow depth (the neutral drop-shadows on cards stay —
"minimal" here means no *color*, not no depth), type pairing, and the badge/series color exception
above.

**How to tell it worked:** no purple or cyan appears anywhere in the shell except the logomark
itself — nav, buttons, stat tiles, links, and the page background are all grayscale. The active nav
pill and primary buttons are still clearly distinguishable (by fill/contrast, not glow). Badge dots
still carry their risk-tier color, just without the halo.

## What must NOT change

- Grid layouts (`.dashboard-grid`, `.grants-layout`, `.stat-grid`), table `colgroup` widths, and all
  component logic/props — this is a surface (color/type/radius/shadow) restyle, not a layout rebuild.
- The badge vocabulary (risk tier → good/warning/critical mapping) and the rule that risk is never
  color-alone (dot + text label) — untouched, per the existing dataviz-skill constraint baked into
  `Badge.tsx`.
- Light/dark toggle behavior (`useTheme.ts`, `data-theme` attribute mechanics) — only the token
  *values* each theme resolves to change, not the switching mechanism.
- `.tabular` / `font-variant-numeric` usage on numeric columns — keep for now-standard column
  alignment; the mockup layers the new mono font on top of it for stat tiles specifically.

## How to tell it worked

- App boots into the dark theme by default (system `prefers-color-scheme: dark` or no stored
  preference); toggling still reaches the light theme with no visual regressions there.
- Nav bar reads as a floating glass pill bar, not a flat bordered strip; the active page's link sits
  in a raised chip.
- Cards have visibly softer, larger corners (16px) and a subtle drop shadow, not a hairline border
  only.
- Stat tile numbers render in Space Grotesk (visibly different letterforms from the body text right
  below them); table headers and ids render in IBM Plex Mono.
- Primary buttons are a flat neutral ink-block fill and the active nav pill is a flat raised chip —
  no accent glow anywhere in the chrome. See [§ Site chrome — monochrome](#site-chrome--monochrome)
  for the full list of what lost its color.
