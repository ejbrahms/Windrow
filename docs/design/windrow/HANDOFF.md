# Handoff — Windrow frontend redesign

Mockup: `docs/design/windrow/Capability Governance Redesign.dc.html` (also live at
https://claude.ai/design/p/d8a0d808-18e1-4108-bb81-fd564078a702?file=Capability+Governance+Redesign.dc.html) —
file name kept as-is to match the hosted design link; the mockup's on-page brand text now reads
"Windrow".

**Assumption stated up front:** there is no shared Wispfield design system reachable from this
project, so "matches the Wispfield look" was interpreted from the visual vocabulary Wispfield's own
UI is described in throughout this repo's harness docs — a dark spatial canvas ("the field") of
cards ("looms") with colored state dots (done/active/blocked), soft glow accents, monospace
technical labels, generous rounded corners. If the real Wispfield app uses a different palette,
swap the hex values in the token table below — the structure (dark-first, glow accent, mono for
data) carries either way.

## What changes, file by file

| File | Change |
|---|---|
| `client/src/styles/theme.css` | Replace `:root` token block with the dark-first palette below. Dark becomes the default `color-scheme`; light mode keeps today's warm-neutral values as the secondary theme, reachable via the existing `[data-theme="light"]` toggle — no changes needed to `useTheme.ts` or `ThemeToggle.tsx`, only the values each theme resolves to. |
| `client/src/styles/app.css` | `.topnav` → rebuild as the pill-nav bar (`.topbar` + `.navpill` in the mockup): sticky, blurred glass background, active link gets a raised chip instead of colored text. `.card` gets `--radius-lg` (16px, up from 6px) and the two-layer shadow. `.stat-tile` gets the corner glow (`::after` radial gradient) and switches its `.value` to the display font. `.badge::before` dot gets a `box-shadow: 0 0 6px currentColor` glow. `.btn-primary` becomes a gradient (`--accent` → `#6f5ff0`) with a glow shadow instead of a flat fill. `th` switches to the mono font. Everything else (grid layouts, table structure, filter row, dialog, chart CSS) is unchanged — only surface, radius, shadow, and accent-treatment values move. |
| `client/index.html` | Add the two Google Fonts `<link>` tags (Space Grotesk, IBM Plex Mono) — same ones in the mockup's `<helmet>`. |
| `client/src/components/Layout.tsx` | Swap the `<nav className="topnav">` markup for the brand-mark + pill-nav structure shown in the mockup (`<span className="brand">` gains a small gradient `.mark` square; links move inside a `.navpill` wrapper). No routing logic changes. |
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
| `--accent` (new) | `#8b7cf6` | keep existing `#2a78d6`, or adopt `#8b7cf6` in both themes for one accent identity — designer's call, flag for review |
| `--radius` | `16px` cards / `12px` tiles / `8px` controls (was flat `6px` everywhere) | same |

Status colors (`--status-good/warning/critical`) and series colors (`--series-1..4`) are untouched —
they're already a reserved, tested palette per the dataviz skill's palette reference; the redesign
only adds a glow (`box-shadow: 0 0 6px currentColor`) to the existing badge dot, it doesn't recolor
them.

New tokens with no prior equivalent — decide before implementing:
- `--accent-glow` / `--accent-soft` (soft-light and shadow-glow variants of `--accent`) — used on the
  active nav pill, primary button shadow, and stat-tile corner wash.
- `--cyan` (`#4fd1e8`) — second accent, used only in dashboard bar-chart fills to keep principals vs.
  capabilities visually distinct; not a UI-chrome color.
- `--font-display` (Space Grotesk) — headings, brand mark, stat-tile values only. Body copy, table
  cells, and forms keep `system-ui` untouched — a data-dense app doesn't want a display font in
  running text.
- `--font-mono` swaps from the current `ui-monospace` stack to IBM Plex Mono for a consistent look
  across code blocks, table headers, and technical labels (ids, timestamps, kind pills).

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
- Primary buttons and the active nav pill show a soft accent glow, not a flat fill.
