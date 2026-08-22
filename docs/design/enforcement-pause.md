# The enforcement pause — turning denials off for a bounded window

*Implemented in `server/enforcementPause.js`, applied in `server/hooks/lib.js`, exposed at
`/api/enforcement/pause` and as `npm run denials:off|on|status`.*

## 1. What it is for

Debugging and testing. When you are working out why a tool call behaves the way it does, an
enforcement layer that denies half of what you try is a second variable in an experiment that
already has one. This turns denials off for a bounded window so the thing under test is the only
thing failing.

```
                    enforcement ON                    pause in force
                    ─────────────                     ──────────────
  no active grant   →  deny  [governance:denied]      →  ALLOW  + audit row
  fault, mutating   →  deny  [governance:fault/…]     →  ALLOW  + audit row
  fault, read_only  →  allow                          →  allow
  revoked grant     →  deny                           →  deny        ← never suppressed
  shell at the API  →  deny                           →  deny        ← never suppressed
  destructive       →  deny / ask                     →  deny / ask  ← unless named explicitly
```

## 2. Why it is not the maintenance grace lease

`server/maintenance.js` already ships a signed, time-boxed window, and this is deliberately *not*
an extension of it:

| | grace lease | enforcement pause |
|---|---|---|
| softens | **faults** — governance did not answer | **decisions** — governance answered *no* |
| overrides a real deny | never | that is the whole point |
| default window | 15 min, cap 60 | 15 min, **floor 5, cap 30** |
| destructive tier | never leasable | opt-in by name |
| exists for | upgrades | debugging |

An operator opening a debugging window must not be able to believe they opened a maintenance one,
and a reader of the audit trail must be able to tell the two apart. Hence a separate file, a
separate name, a separate journal tag, and a tighter cap.

## 3. What bounds it

It is a real bypass, so it is bounded five ways.

1. **Minted by a healthy server.** HMAC-signed with the agent token, written only by
   `POST /api/enforcement/pause`. There is no offline path. An attacker who kills the API to force
   a fail-open cannot sign a pause, because signing requires the thing they just killed. That
   property is the reason this feature is a signed lease rather than a flag.
2. **Time-boxed, 5–30 minutes.** An expired pause is no pause, checked by the reader, so a
   forgotten window re-tightens with nobody doing anything.
3. **Admin-scoped.** `requireAdmin`, i.e. an enrolled admin certificate over the mTLS listener. The
   agent token every hook carries cannot open one — otherwise any governed call would be a way to
   stop being governed.
4. **Tier-scoped.** `tolerate` defaults to `read_only, mutating`. `destructive` is available but
   only when named: the short form gives a window that still stops a destructive call.
5. **Loud.** Every suppressed denial is a row in `server/data/hook-fault-journal.jsonl` tagged
   `why: "enforcement-pause"`, carrying the pause id and what the decision *would* have been. The
   server logs the window on a 60-second heartbeat and logs once more when it lapses.

Two denials are never suppressed, at any tier setting:

* **A revocation.** A grant on the deny-list is central saying *stop*, not this node saying *you
  never had one* — and it is the denial most likely to have been issued because of what the person
  wanting a window was doing.
* **Direct shell access to the governance API or its token file.** A standing rule against
  replicating a hook without going through one; a debugging window is exactly the cover a bypass of
  it would want.

A denial whose **risk tier is unknown** — an unresolvable capability, or one missing from a stale
replica — is covered only by a pause naming all three tiers. `tolerate` is a list of tiers, and one
we could not determine cannot be on it.

## 4. Four ways in, one file out

```
  UI    Hook Integrity → "Turn off denials"   ─┐
  CLI   npm run denials:off 20m "repro #412"  ─┤
  API   POST /api/enforcement/pause           ─┼─→  server signs it  →  hook-enforcement-pause.json
  ENV   WINDROW_DISABLE_DENIALS=20m           ─┘   (while healthy)          ↑ read by every hook
                                                                            (signature checked)
```

The env var is read by the **server** at boot, not by the hook. A hook reading its own bypass flag
out of the agent's environment would be a bypass every governed process could set for itself. The
variable is an instruction to a server that is coming up healthy to mint a signed pause — the same
trust boundary as the route. A hook only ever reads a signed file.

```bash
npm run denials:off                        # 15 minutes, read_only + mutating
npm run denials:off 20m "repro #412"       # 20 minutes, with a reason on every audit row
npm run denials:off 10m --tiers=read_only,mutating,destructive "testing the delete path"
npm run denials:status                     # how long is left, on which tiers
npm run denials:on                         # close it early; it expires regardless
```

```
WINDROW_DISABLE_DENIALS=1            the default window (15 min) on the default tiers
WINDROW_DISABLE_DENIALS=20m          20 minutes; clamped into [5m, 30m]
WINDROW_DISABLE_DENIALS_TIERS=read_only,mutating,destructive
WINDROW_DISABLE_DENIALS_REASON="repro #412"
```

Unset, `0` or `false` does nothing at all — including *not* revoking a pause opened through the API,
because a restart during a debugging window should not end the window.

### The dashboard control

`client/src/components/EnforcementPauseCard.tsx`, on the **Hook Integrity** page under *Security* —
that page already answers "is governance still wired up?", and this is the same question from the
other side. A duration (5–30), a reason that lands on every audit row, and tier checkboxes with
`destructive` unchecked and visually set apart, mirroring the server's rule rather than inventing a
client-side one. Opening a window goes through a confirm dialog that names the tiers, because the
difference between covering reads and covering deletes is the whole risk.

`client/src/components/EnforcementPauseBanner.tsx` renders in the app chrome above *every* page
while a window is open, with a live countdown and a "Resume now" button. It uses the **warning**
tokens, not the critical ones: this is a state someone deliberately chose, and painting it red would
put it in the same visual bucket as "governance is broken", which is the one thing it must not be
mistaken for. It renders nothing at all in the normal case.

Both share `useEnforcementPause` (a context, not two fetches) so opening a window puts the banner up
on the same paint rather than a poll interval later — and it still polls every 15 s, because a
window can be opened from the CLI, the API or the env var, and closes itself on a timer this browser
did not start.

**Where you will actually see it.** The control reads `/api/enforcement/pause`, which needs a
credential the API accepts, so it appears on a dashboard loaded at **`http://localhost:5173`** via
`npm run dev:client` (the Vite proxy presents the enrolled `dev` certificate). A dashboard opened on
the plaintext listener at `:4000` authenticates as nobody, so the card hides itself rather than
showing a form that 403s on submit. Opening and closing need an **admin** certificate; a non-admin
one gets the API's own "requires an admin certificate" error on submit.

## 5. Where it applies in the hook

`enforcementPauseOverride()` in `server/hooks/lib.js` is the single suppression point. Every deny
site routes its would-be decision through it, so "is enforcement paused?" is asked once and
journalled identically however the denial arose. It is applied to `faultPolicy`'s **output** rather
than woven into the ladder's branches, so the ladder keeps stating the real policy in one readable
piece and the pause stays a visible override on top of it.

When a pause turns a real `no active grant` into an allow, the hook also writes a pending file:
`/invoke` has already logged that call as `denied`, and the tool is about to run, so `PostToolUse`
corrects the row with the real outcome. Otherwise the audit trail would claim a call was blocked
when it was not.

## 6. What is asserted

`node server/enforcementPause-test.js` (`npm run test:enforcement-pause --prefix server`) checks
eight properties, each chosen because it is a way this could look correct and not be: it actually
suppresses; it is tier-scoped; it expires; it is clamped at both ends; a hand-written or
signature-preserved-but-edited pause file is ignored; an unknown tier needs the full pause; every
suppressed denial is journalled with the pause id; and the env var parses the way this document
says — in particular `WINDROW_DISABLE_DENIALS=1` means the default window and not one millisecond.
