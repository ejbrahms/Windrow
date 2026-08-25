# Handoff — Windrow frontend redesign

Mockup: `docs/design/windrow/exports/Capability Governance Redesign.dc.html` (also live at
https://claude.ai/design/p/d8a0d808-18e1-4108-bb81-fd564078a702?file=Capability+Governance+Redesign.dc.html) —
file name kept as-is to match the hosted design link; the mockup's on-page brand text now reads
"Windrow".

**Logomark addendum:** the prior pass above left the brand mark as a generic gradient square
placeholder — it didn't solve what the mark should actually look like. See
[the "Logomark" section below](#logomark--the-windrow-mark) for the concept, the token/file changes
it needs, and the original pick: **1a, colored** (raked-rows, tapered wedges, tinted
`--accent`→`--cyan`). *Superseded: [Addendum 4](#addendum-4--5-new-logomark-options--2a-picked)
below replaced this pick with **2a, Raked Furrows** — a fresh direction, not a revision of 1a. Use
2a's markup and file table in Addendum 4 for the actual implementation; 1a below is kept for
history only.*
Mockup: `docs/design/windrow/exports/Logomark Concepts.dc.html` (also live at
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

**3 directions explored** (`docs/design/windrow/exports/Logomark Concepts.dc.html`):

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

Mockup: `docs/design/windrow/exports/Site Chrome Monochrome.dc.html` — the before/after of every
surface this section changes, side by side, so the token table below can be read against a picture
rather than imagined.

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

## Addendum 3 — left sidebar nav + strict minimal palette

**Ask:** two changes on top of everything above: (1) move nav from the top pill bar to a
collapsible left sidebar — icon-only when collapsed (tooltips on hover), icon + label when
expanded, default expanded, state persisted; content gets a left inset instead of a top inset;
(2) go stricter than the existing monochrome pass — at most 1-2 accent colors in the *whole* UI
(grayscale + functional status/series colors + the logomark's own accent are the exceptions), and
audit for any remaining glow, box-shadow halo, gradient, or blurred background and remove it.

Mockup: `docs/design/windrow/exports/Left Sidebar Nav.dc.html`, showing both states side by side plus a
before/after audit table. **Publish to the hosted Claude Design project failed** —
`write_files` returned `no active grant for mcp_tool "write_files"` on every retry, the same
interruption Addendum 1 hit mid-session on this project. The file is written and correct at the
path above (readable directly, or opened locally); it is not yet live at
`https://claude.ai/design/p/d8a0d808-18e1-4108-bb81-fd564078a702?file=Left+Sidebar+Nav.dc.html` —
retry `write_files` for that path when the project grant is restored, no content changes needed.

### Sidebar nav — file by file

| File | Change |
|---|---|
| `client/src/components/Layout.tsx` | Replace the `<nav className="topnav">` structure with a sidebar: `<div className="app-shell">` wraps `<aside className={"sidebar" + (collapsed ? " collapsed" : "")}>` and `<div className="shell-main"><Outlet /></div>`. The sidebar holds, top to bottom: a `.sidebar-top` with the existing `.brand` (mark + wordmark — wordmark wrapped in a new `<span className="nav-label">` so it hides the same way nav labels do), a `<nav className="sidebar-nav">` of `.navitem` links (one per `LINKS` entry, now including `Docs` — see below), a `.sidebar-bottom` holding a `.util-row` of icon buttons (`SettingsMenu`, the GitHub link, `ThemeToggle` — same components, just relocated and each wrapped/restyled as an `.icon-btn`), and a `.collapse-toggle` button as the last child. `setup-guide-link` moves into the util row too, as an icon button (a "?" or guide glyph) with `title="Setup guide"` — icon-only even when expanded, since it's a secondary action, not a primary nav destination. |
| `client/src/components/Layout.tsx` | `LINKS` gains a sixth entry, `{ to: "/docs", label: "Docs" }` — Docs moves from the `SettingsMenu` dropdown to a top-level sidebar item per the new spec's explicit 6-page list (Catalog, Principals, Grants, Dashboard, Fleet, Docs). `SettingsMenu`'s `SETTINGS_LINKS` drops the `Docs` entry accordingly (keeps `Providers & Integrations`, `Sources`). |
| `client/src/components/Layout.tsx` | Each `.navitem` gets an icon: add a small `NAV_ICONS: Record<string, JSX.Element>` map keyed by `to`, one inline `<svg viewBox="0 0 24 24">` per page built only from `<line>`/`<rect>`/`<circle>`/`<polyline>`/`<path>` straight-line/arc primitives (list-bars for Catalog, two overlapping circles for Principals, a circle+checkmark for Grants, a 2×2 square grid for Dashboard, a corner arrow for Fleet, a ruled rect for Docs — exact paths in the mockup's `<nav class="sidebar-nav">` markup). Render `<span className="nav-icon">{NAV_ICONS[link.to]}</span><span className="nav-label">{link.label}</span>` inside each `NavLink`. |
| `client/src/components/Layout.tsx` (new) or `client/src/hooks/useSidebarCollapse.ts` (new) | New hook, same shape as `useTheme.ts`: reads `localStorage.getItem("windrow.sidebarCollapsed")` on init (`"1"` → collapsed, anything else/missing → expanded, i.e. **default expanded**), exposes `{ collapsed, toggle }`, and writes back to localStorage on every `toggle()`. `Layout` calls it once and passes `collapsed` down to the `aside` className and up to the toggle button's `onClick`. |
| `client/src/styles/app.css` | Remove `.topnav`, `.topnav .brand`, `.topnav .brand-icon`, `.topnav a`, `.topnav a:hover`, `.topnav a.active`, `.topnav-spacer` (superseded — the pill bar no longer exists). Add `.app-shell` (flex row, full height), `.sidebar` / `.sidebar.collapsed` (width from the two new tokens below, `flex: none`, full-height flex column, `border-right` instead of `border-bottom`), `.sidebar-top`, `.brand`/`.brand .mark`/`.brand .wordmark` (mark unchanged 22px box; wordmark is the `.nav-label` that hides on collapse), `.sidebar-nav`, `.navitem` / `.navitem:hover` / `.navitem.active` (active state: same flat `box-shadow: 0 0 0 1px var(--rule-strong)` chip the old `.navpill a.active` used — no new visual language needed), `.nav-icon`, `.nav-label`, `.navtip` (the collapsed-state tooltip, shown via `.navitem:hover .navtip` — pure CSS, no JS needed for the hover case; the toggle only needs to persist collapsed/expanded, not tooltip visibility), `.sidebar-bottom`, `.util-row`, `.icon-btn` (replaces the ad hoc `.github-link`/`.settings-menu-trigger`/`.theme-toggle` sizing rules — those three can now share one `.icon-btn` class plus their existing distinguishing bits), `.collapse-toggle` (chevron rotates 180° via the `.sidebar.collapsed .collapse-toggle svg` rule — one icon, two meanings, no separate expand glyph needed). `.shell-main` replaces the implicit "everything below the topnav" — `flex: 1; min-width: 0`, no margin/padding of its own (the existing `.page` class's own max-width/padding still applies unchanged inside it). |
| `client/src/styles/theme.css` | Add two tokens to `:root` (same value in light and dark — sidebar width isn't themed): `--sidebar-w-expanded: 220px;` and `--sidebar-w-collapsed: 64px;`. No color tokens change. |
| `client/src/components/SettingsMenu.tsx` | Drop `Docs` from `SETTINGS_LINKS` (now `Providers & Integrations`, `Sources` only, since Docs is a top-level sidebar item — see above). No other logic changes; it still renders a trigger + dropdown, just now inside `.util-row` sized as an `.icon-btn` — swap the trigger's visible text label for icon-only with `title="Settings"` / `aria-label="Settings"` (the dropdown itself, and its `SETTINGS_LINKS` items, keep their text labels; only the trigger button in the collapsed util row goes icon-only, same as it already does today when space is tight). |
| `client/src/components/ThemeToggle.tsx` | No changes — already icon-only, drops into `.util-row` as-is. |
| Every page under `client/src/pages/` | No structural changes. Each page's `.page` wrapper already only assumes "some ancestor provides the header space" — swapping that ancestor from a top bar to a left sidebar changes nothing about `.page`'s own max-width/padding/grid rules (`.dashboard-grid`, `.grants-layout`, `.stat-grid` all untouched, per the existing "what must NOT change" list below). |

**Collapse/expand mechanics:**
- Default: expanded (`--sidebar-w-expanded`, 220px), matching "default expanded" in the ask.
- Toggle: `.collapse-toggle` button, pinned as the last element in `.sidebar-bottom` so it's reachable in both states at a fixed location; chevron icon flips direction (`◀` expanded → `▶` collapsed) as the only state indicator needed beyond the width change itself.
- Persistence: `localStorage["windrow.sidebarCollapsed"]`, read once on mount, written on every toggle — same pattern `useTheme.ts` already uses for the light/dark preference, so no new persistence mechanism enters the codebase.
- Collapsed width (64px) fits one centered icon plus its hover padding; nothing is clipped or scrollbarred at that width for any of the 6 nav items + 3 util icons + toggle.
- Tooltips: real CSS `:hover` on `.navitem`, scoped to `.sidebar.collapsed` so expanded mode (which already shows the label inline) never shows a redundant tooltip. No JS/ARIA live region needed for the hover case; if a future pass adds keyboard-focus tooltips, reuse the same `.navtip` element and add a `.navitem:focus-visible .navtip` rule.

**Content inset — the specific ask:** `.page` and every page-level grid keep their current CSS untouched. The inset comes entirely from `.app-shell` being a flex row with `.sidebar` as a fixed-width flex item and `.shell-main` as `flex: 1` — there is no `margin-left` hack on `.page` and no `padding-top` hack left over from the old sticky top bar. This is why no page file needs to change: the inset direction flipped (top → left) but the mechanism (an ancestor claims space, `.page` fills what's left) is the same one already in place, just on a different axis.

### Strict minimal palette — audit and changes

**Rule restated:** at most 1-2 accent colors in the whole UI. The existing badge/status colors
(`--status-good/warning/critical`) and chart series colors (`--series-1..4`) are exempt — they're
functional, not decorative, per the original redesign pass. The logomark's own `--accent`/`--cyan`
fill is exempt too — the one deliberate brand exception, per [Logomark](#logomark--the-windrow-mark)
above. Nothing else may use `--accent`, `--cyan`, or introduce any new hue. This was already true
after [§ Site chrome — monochrome](#site-chrome--monochrome); this pass extends the *same* rule to
glow, box-shadow halos, gradients, and blur — none of which are color per se, but all read as the
same kind of decoration the monochrome pass was already rejecting.

| Element | Before (monochrome pass) | After (this pass) | File |
|---|---|---|---|
| Sidebar/top-bar background | `.topbar` used `background: rgba(10,10,13,.82); backdrop-filter: blur(14px)` (glass effect) | `.sidebar` is a flat opaque `var(--surface)` — no transparency, no `backdrop-filter` anywhere in the shell | `client/src/styles/app.css` |
| `.card` shadow | `box-shadow: 0 1px 0 rgba(255,255,255,.02) inset, 0 12px 30px -18px rgba(0,0,0,.6)` — the second layer is a soft 30px-blur drop shadow | `box-shadow` removed entirely; `.card` is `border: 1px solid var(--rule)` only | `client/src/styles/app.css` |
| `.settings-menu-dropdown` shadow | `box-shadow: 0 8px 24px rgba(0,0,0,.16)` | Removed; border only (`1px solid var(--rule)`, already present) | `client/src/styles/app.css` |
| `.switch .track::before` (toggle thumb) shadow | `box-shadow: 0 1px 2px rgba(0,0,0,.3)` | Removed; the thumb already has full contrast against `.track`'s fill, no shadow needed for legibility | `client/src/styles/app.css` |
| Active nav chip (`.navitem.active`, formerly `.navpill a.active`) | `box-shadow: 0 0 0 1px var(--rule-strong)` — 0 blur radius | **Unchanged.** A 0-blur box-shadow is a crisp ring, functionally a border-in-a-different-property, not a halo — the strict rule targets blur/spread, not every box-shadow declaration | `client/src/styles/app.css` |
| `.dialog-backdrop` / `.onboarding-backdrop` scrim | `background: rgba(0,0,0,.45)` | **Unchanged.** A flat translucent fill behind a modal is not a glow, gradient, or blur — it's a scrim, and removing it would hurt usability for no minimalism gain | `client/src/styles/app.css` |
| Any gradients | None remained after the first monochrome pass (`.btn-primary` was already flattened to solid ink fill) | Confirmed still none | — |
| Accent color usage | Retired from all UI chrome; only the logomark's `--accent`/`--cyan` fill remained | Confirmed still only the logomark; the sidebar's active/hover states are grayscale (`--surface-raised`, `--surface-hover`, `--ink`) — no accent was reintroduced anywhere in the new sidebar markup | `client/src/styles/app.css`, `client/src/components/Layout.tsx` |

**What must NOT change (this addendum):** the badge/status/series color exception, the logomark's
own accent/cyan fill, the light/dark toggle mechanism, all page-level grid layouts, and the type
pairing — none of that is touched by either the sidebar move or the shadow/blur cleanup.

**How to tell it worked:**
- Nav lives in a left column at every one of the 6 pages (Catalog, Principals, Grants, Dashboard,
  Fleet, Docs); no top bar remains.
- Clicking the collapse toggle shrinks the sidebar to icon-only, reloading the page (or navigating)
  keeps it collapsed — same for expanded — because the choice reads from `localStorage` on mount.
- Hovering a nav icon in the collapsed state shows its label in a small tooltip to the right of the
  icon; expanded state shows the label inline instead and never shows a tooltip.
- No page's grid (`.dashboard-grid`, `.grants-layout`, `.stat-grid`) visibly shifts, wraps
  differently, or clips compared to before — only the ancestor claiming space changed axis.
- Nothing in the app blurs, glows, or casts a soft shadow: inspecting any element's computed
  `box-shadow` shows either `none` or a 0-blur-radius ring; no element has `backdrop-filter` or
  `filter: blur(...)`; no `background` uses `linear-gradient`/`radial-gradient` except the existing
  dot-grid page background (a repeating radial-gradient *pattern*, not a soft wash — unchanged from
  the monochrome pass, called out there as staying).
- The only two colors outside grayscale/status/series anywhere in the rendered app are the
  logomark's purple and cyan fills, and they appear nowhere but the brand mark.

## Addendum 4 — 5 new logomark options — **2a picked, shipped**

**Ask:** the logomark still hasn't shipped — `Layout.tsx` and `index.html` still hold the original
wind-gust `brand-icon` (three curved strokes of shrinking width, all starting from one point).
Produce 5 fresh trail/row concepts, distinct from round 1's 1a/1b/1c, following the same
constraints (strict-minimal palette exception for the mark only, ≤1-2 accent colors, one
monochrome option included).

**Pick: 2a — Raked Furrows** (3 tapered diagonal bars of decreasing length, `--accent`/`--cyan`,
two colors). The implementer should apply the file-by-file table below directly — this is now the
current spec, same as round 1's 1a was before it.

Mockup: `docs/design/windrow/exports/Logomark Options.dc.html` (also live at
https://claude.ai/design/p/d8a0d808-18e1-4108-bb81-fd564078a702?file=Logomark+Options.dc.html).
Shows all 5 at 76px detail, real 24px nav size, and real 16px favicon-tab size.

**Shared constraint check:** none of the 5 use a closed loop, arc, or curl — every shape is
straight-edged (rects, polygons, or straight lines) and shortens/thins/lowers left→right, which is
the visual idea that makes something read as "a row that runs out" rather than "air that's
curling." That's the one test every option below was built against.

| # | Direction | Colors | Why it reads as trail/row, not wind |
|---|---|---|---|
| 2a **— picked** | **Raked Furrows** — 3 tapered diagonal bars, straight-edged (not curved like round-1's 1a), each a different length | 2 — `--accent` (bars 1–2), `--cyan` (bar 3) | Different lengths per bar (not 3 parallel copies) reads as "this row ran out sooner" — a cross-section of raked material, not a fan of moving air |
| 2b | **Windrow Ridges** — 3 flat horizontal bars, left-aligned, each shorter than the last | 1 — monochrome `currentColor` | The plainest "rows of decreasing length" reading; solid rectangles hold up best of all 5 at 16px since there's no taper geometry to lose. This is the required monochrome option |
| 2c | **Swept Pile** — a ground baseline with 4 triangular mounds of decreasing height sitting on it | 1 — `--accent` | Grounded on a baseline instead of floating strokes, so it reads unambiguously as material heaped on the ground, never air |
| 2d | **Trail Dashes** — 4 short marks along one falling diagonal, each smaller and lower than the last, with real gaps between them | 2 — `--accent` (marks 1–2), `--cyan` (marks 3–4) | Isolated marks (vs. 2a/2b's continuous bars) read as scattered leftovers fading into the distance — footprints, not airflow |
| 2e | **Comb Rake** — one diagonal line (the pass itself) crossed by 3 tine-marks that shrink toward one end | 2 — `--accent` (main line), `--cyan` (ticks) | No arc anywhere at all — the line is the furrow directly, the ticks are the rake's texture on it, the strongest "definitely not wind" of the five, but also the most linework-heavy, worth double-checking at an actual rendered 16px |

**The 5 marks, as SVG** — all `viewBox="0 0 24 24"`, straight-line primitives only (`rect`,
`polygon`, `line`), sized to read at both 24px nav and 16px favicon:

```svg
<!-- 2a — Raked Furrows -->
<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <polygon points="2,2.6 2,5.6 20,7.1 20,6.5" fill="var(--accent)"/>
  <polygon points="2,9.6 2,12.2 15.5,13.3 15.5,12.7" fill="var(--accent)"/>
  <polygon points="2,15.8 2,18 11,18.7 11,18.2" fill="var(--cyan)"/>
</svg>

<!-- 2b — Windrow Ridges (monochrome) -->
<svg viewBox="0 0 24 24" aria-hidden="true">
  <rect x="3" y="5" width="18" height="2.6" fill="currentColor"/>
  <rect x="3" y="10.7" width="13" height="2.6" fill="currentColor"/>
  <rect x="3" y="16.4" width="8" height="2.6" fill="currentColor"/>
</svg>

<!-- 2c — Swept Pile -->
<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <rect x="2" y="19.2" width="20" height="1.6" fill="var(--accent)"/>
  <polygon points="3,19.2 6.4,19.2 4.7,9.4" fill="var(--accent)"/>
  <polygon points="8.2,19.2 11.2,19.2 9.7,12.6" fill="var(--accent)"/>
  <polygon points="13,19.2 15.6,19.2 14.3,15.4" fill="var(--accent)"/>
  <polygon points="16.8,19.2 18.8,19.2 17.8,17.4" fill="var(--accent)"/>
</svg>

<!-- 2d — Trail Dashes -->
<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <rect x="2" y="7.6" width="6.4" height="2.6" fill="var(--accent)"/>
  <rect x="10" y="11.6" width="4.6" height="2.1" fill="var(--accent)"/>
  <rect x="16" y="15" width="3.2" height="1.6" fill="var(--cyan)"/>
  <rect x="20.2" y="17.6" width="1.8" height="1" fill="var(--cyan)"/>
</svg>

<!-- 2e — Comb Rake -->
<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <line x1="3" y1="20" x2="21" y2="4" stroke="var(--accent)" stroke-width="1.7" stroke-linecap="round"/>
  <line x1="5.4" y1="14.6" x2="8.6" y2="18.2" stroke="var(--cyan)" stroke-width="1.5" stroke-linecap="round"/>
  <line x1="11" y1="10.8" x2="13" y2="13.2" stroke="var(--cyan)" stroke-width="1.5" stroke-linecap="round"/>
  <line x1="16.4" y1="7" x2="17.6" y2="8.3" stroke="var(--cyan)" stroke-width="1.5" stroke-linecap="round"/>
</svg>
```

**File-by-file — 2a, ready to apply:** identical mechanism to round 1's pick (see
[Logomark — the windrow mark](#logomark--the-windrow-mark) above) —

| File | Change |
|---|---|
| `client/src/components/Layout.tsx` | Replace the `brand-icon` `<svg>` body (currently the wind-gust 3-path curl) with 2a's 3 `<polygon>`s from the block above. Keep `viewBox="0 0 24 24"` and `className="brand-icon"`; keep `fill="none"` on the root `<svg>` since each polygon carries its own `fill`. Swap the two literal hex fills for `var(--accent)` (polygons 1–2) and `var(--cyan)` (polygon 3) in the actual JSX, same as round 1's pick did. |
| `client/index.html` | Replace the inline `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,...">` data URI with the same 3 polygons, colors baked in as literal hex (`#8b7cf6` / `#4fd1e8`) since a `data:` URI can't read CSS variables — same caveat as round 1. URL-encode the same way the current favicon is encoded. |
| `client/src/styles/app.css` | No new rules needed beyond what round 1 already added for `.brand-icon` — the SVG is filled per-polygon, no CSS-driven fill/stroke rule required. |

**What must NOT change:** same as round 1 — `viewBox="0 0 24 24"`, the `.brand .mark` 22px box,
and the wordmark "Windrow" next to it. 2a keeps the "at most 1-2 accent colors, logomark only"
rule exactly as Addendum 3 specified — two colors (`--accent`, `--cyan`), same tokens round 1's
pick already used, nothing new introduced.

**How to tell it worked:** the nav mark and the browser-tab favicon both show three tapering
diagonal bars of decreasing length at 24px and 16px respectively, with no blur or illegible
overlap at either size — not three lines of shrinking width curling from one point, which is what
the current shipped mark still does. 2b/2c/2d/2e remain documented above and in
`Logomark Options.dc.html` as unpicked alternatives, not discarded — same convention as round 1's
1b/1c.

**Shipped.** Applied directly to the actual codebase (not the hypothetical dark-first palette
Addendum 1/2 assumed — the app's real `theme.css` kept its original light-first, single-accent
tokens throughout): `client/src/components/Layout.tsx`'s `brand-icon` now renders 2a's 3
`<polygon>`s, `client/index.html`'s favicon data URI matches with baked hex, and `theme.css` gained
one new non-themed `--cyan: #2ea7ae` token (same value in light and dark, alongside the sidebar
width tokens) since no `--cyan` existed in the shipped palette before this. The mark's first two
bars use the real `--accent` (`#4b7bb5` light / `#5a8ac4` dark, not the doc's purple `#8b7cf6`) —
the favicon bakes the light-theme accent hex since a `data:` URI can't switch with the page theme.
`tsc -b` and `vite build` both pass; verified by screenshot that the mark renders as three
tapering bars next to the wordmark, no curl.
