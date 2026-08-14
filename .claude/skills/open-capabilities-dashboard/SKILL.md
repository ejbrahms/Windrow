---
name: open-capabilities-dashboard
description: Use when asked to open, show, or check the capability-governance dashboard (capabilities, grants, principals, usage) — brings it up as a live field card instead of a separate browser tab.
---

# Open capabilities dashboard

This project has no true native panel inside Wispfield's own app shell (that's closed-source, not
this repo) — the closest native integration is a **field card**: a browser loom pointed at the
governance client, sitting alongside every other loom instead of a separate browser tab. This
skill gets one on screen with the fewest steps, reusing an existing card if there is one.

## 1. Make sure both dev servers are up

Check, don't assume:

```bash
netstat -ano | grep -E ':4000|:5173' || echo "neither listening"
```

- **Server not listening on :4000** — start it detached from `server/`: `npm start` (background;
  never run a dev server in the foreground turn).
- **Client not listening on :5173** — start it detached from `client/`: `npm run dev` (background).

Give a freshly-started server a couple seconds before opening the page against it.

## 2. Open or refocus the card

Check the field for a browser loom already titled `Capabilities` (`wispfield_get_field_status`).

- **Already there** → `wispfield_navigate_loom` with `targetHumanName: "Capabilities"` and
  `url: "http://localhost:5173/#/catalog"`. Reuses the card instead of opening a duplicate.
- **Not there** → `wispfield_spawn_agent` with `agentType: "browser"`, `title: "Capabilities"`,
  `url: "http://localhost:5173/#/catalog"`.

## 3. Route to what was actually asked for

The catalog (`/#/catalog`) is the default landing spot — capability definitions and risk tiers.
If the ask is specifically about grants, principals, or usage/drift, use that route instead:

| Ask | Route |
|---|---|
| Capabilities / catalog / risk tiers | `/#/catalog` |
| Grants / who has access | `/#/grants` |
| Principals / roles / instances | `/#/principals` |
| Usage, drift, denial rate | `/#/dashboard` |
