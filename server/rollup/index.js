'use strict';
// Cross-workspace usage rollup — docs/design/cross-field-and-standalone.md. Reads other
// workspaces' governance.db files directly, read-only, and merges them with this workspace's own
// live data. No shared write path, no network, no new auth surface: exactly the "ship a rollup,
// not a rewrite" migration docs/design/deployment-boundary-decision.md promised.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const store = require('../store');

// Default root: the platform's workspace root, one level above this workspace's own directory
// (e.g. `C:\Projects` is the parent of `C:\Projects\windrow`). Override with
// WISPFIELD_FIELDS_ROOT for a non-default layout.
const THIS_FIELD_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_ROOT = path.dirname(THIS_FIELD_DIR);
const FIELDS_ROOT = process.env.WISPFIELD_FIELDS_ROOT || DEFAULT_ROOT;
const THIS_FIELD_NAME = path.basename(THIS_FIELD_DIR);

/** Every sibling directory under the fields root that looks like a workspace running this same
 * governance system (has server/data/governance.db), plus this workspace itself. Doesn't require
 * the other workspace's server to be running — only that its db file exists on disk. */
function discoverFieldDirs(root = FIELDS_ROOT) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(root, e.name));
  // Make sure this workspace itself is always included even if it's not literally one level under
  // `root` in some non-standard layout (e.g. WISPFIELD_FIELDS_ROOT overridden to something that
  // doesn't contain it).
  if (!dirs.includes(THIS_FIELD_DIR)) dirs.push(THIS_FIELD_DIR);
  return dirs.filter((dir) => fs.existsSync(path.join(dir, 'server', 'data', 'governance.db')));
}

/** Opens one workspace's db read-only and pulls the rows a rollup needs. Never throws — an
 * unreachable/locked/corrupt db is reported as `reachable: false` rather than aborting the whole
 * rollup for every other workspace. */
function readField(fieldDir) {
  const dbPath = path.join(fieldDir, 'server', 'data', 'governance.db');
  const fieldName = path.basename(fieldDir);
  const base = { field: fieldName, fieldPath: fieldDir, dbPath };

  // This workspace's own db may currently be open read-write by the running server (this very
  // process, in fact) — read it straight through the store module instead of opening a second
  // handle on the same file, which is both unnecessary and (on some platforms) contention-prone.
  if (fieldDir === THIS_FIELD_DIR) {
    try {
      const principals = store.listPrincipals();
      const usageEvents = store.listUsageEvents();
      return { ...base, reachable: true, principals, usageEvents };
    } catch (err) {
      return { ...base, reachable: false, error: err.message, principals: [], usageEvents: [] };
    }
  }

  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const principals = db.prepare('SELECT * FROM principals').all().map((p) => ({ ...p, standalone: !!p.standalone }));
    const usageEvents = db.prepare('SELECT * FROM usage_events ORDER BY ts DESC').all();
    return { ...base, reachable: true, principals, usageEvents };
  } catch (err) {
    return { ...base, reachable: false, error: err.message, principals: [], usageEvents: [] };
  } finally {
    if (db) db.close();
  }
}

function principalDisplayName(principal, fallbackId) {
  if (!principal) return fallbackId;
  return principal.humanName || principal.name;
}

/** `GET /api/rollup/fields` payload: which workspaces were found and whether each was reachable.
 *
 * Directory discovery alone misses workspaces that only exist inside another workspace's shared
 * db (Mode B — see `docs/design/deploy-capability-governance-server` skill) and never had their
 * own `server/data/governance.db` on disk. Those workspaces are real (their principals carry a
 * real `field` value, same as summary() now accounts for) but would otherwise not appear in this
 * list at all. Fold them in as `sharedOnly: true` rows so a workspace isn't invisible just because
 * it never got a directory of its own on this machine. */
function listFields() {
  const dirs = discoverFieldDirs();
  const reads = dirs.map(readField);
  const fields = reads.map((r) => {
    const lastEventAt = r.usageEvents.length ? r.usageEvents[0].ts : null; // already newest-first
    return {
      field: r.field,
      fieldPath: r.fieldPath,
      dbPath: r.dbPath,
      reachable: r.reachable,
      error: r.error || null,
      principalCount: r.principals.filter((p) => !p.standalone).length,
      eventCount: r.usageEvents.length,
      lastEventAt,
      sharedOnly: false,
    };
  });

  const knownFieldNames = new Set(fields.map((f) => f.field));
  const sharedOnly = new Map(); // workspace name -> { principalCount, eventCount, lastEventAt }
  for (const r of reads) {
    if (!r.reachable) continue;
    const principalsById = new Map(r.principals.map((p) => [p.id, p]));
    for (const p of r.principals) {
      if (p.standalone || !p.field || knownFieldNames.has(p.field)) continue;
      if (!sharedOnly.has(p.field)) {
        sharedOnly.set(p.field, { principalCount: 0, eventCount: 0, lastEventAt: null });
      }
      sharedOnly.get(p.field).principalCount += 1;
    }
    for (const e of r.usageEvents) {
      const principal = principalsById.get(e.principalId);
      if (!principal || principal.standalone || !principal.field || knownFieldNames.has(principal.field)) continue;
      const entry = sharedOnly.get(principal.field);
      if (!entry) continue;
      entry.eventCount += 1;
      if (!entry.lastEventAt || e.ts > entry.lastEventAt) entry.lastEventAt = e.ts;
    }
  }
  for (const [field, entry] of sharedOnly) {
    fields.push({
      field,
      fieldPath: null,
      dbPath: null,
      reachable: true,
      error: null,
      principalCount: entry.principalCount,
      eventCount: entry.eventCount,
      lastEventAt: entry.lastEventAt,
      sharedOnly: true,
    });
  }

  return { root: FIELDS_ROOT, thisField: THIS_FIELD_NAME, fields };
}

/** `GET /api/rollup/summary` payload: merges usage across every reachable workspace, with
 * standalone usage (no workspace of its own by construction) broken out separately.
 *
 * A single db no longer implies a single workspace: under the shared-server deployment
 * (`docs/design/deployment-boundary-decision.md`'s "Status update: switched to shared"), one
 * `governance.db` holds principals/events for every workspace whose hooks point at it, each
 * already tagged with its own real `field` column (`server/principals/fromEnv.js`). So the
 * workspace a call belongs to has to come from **the principal that made it**, not from which
 * directory's db happened to be read (`r.field`) — that was only ever correct under Mode A (one
 * db per workspace), where every principal in a workspace's db necessarily had that same
 * workspace. Without this, every non-standalone principal from a workspace other than the one
 * hosting the db got folded into `r.field` instead — indistinguishable in the UI from that
 * workspace's own principals, and easy to misread as "not attributed to any workspace", i.e.
 * standalone. Falling back to `r.field` still covers the genuine edge case of a usage event whose
 * principal row is missing entirely. */
function summary() {
  const dirs = discoverFieldDirs();
  const reads = dirs.map(readField);

  const totals = { calls: 0, denied: 0 };
  const byFieldMap = new Map();
  const byPrincipalMap = new Map(); // key: display name + workspace-or-standalone bucket
  const standaloneByBackend = new Map();

  // Seed byFieldMap from every non-standalone principal's own `field`, not just workspaces that
  // had usage events — a workspace with registered principals but zero calls yet should still
  // show up with a real principalCount instead of being invisible until its first call.
  for (const r of reads) {
    if (!r.reachable) continue;
    for (const p of r.principals) {
      if (p.standalone || !p.field) continue;
      const bucket = byFieldMap.get(p.field) || {
        field: p.field,
        fieldPath: p.field === r.field ? r.fieldPath : null,
        calls: 0,
        denied: 0,
        principalCount: 0,
      };
      bucket.principalCount += 1;
      byFieldMap.set(p.field, bucket);
    }
  }

  for (const r of reads) {
    if (!r.reachable) continue;
    const principalsById = new Map(r.principals.map((p) => [p.id, p]));

    for (const e of r.usageEvents) {
      totals.calls += 1;
      const denied = e.outcome === 'denied';
      if (denied) totals.denied += 1;

      const principal = principalsById.get(e.principalId);
      const isStandalone = Boolean(principal && principal.standalone);
      // The event's real workspace: the principal's own `field`, not the db file it happened to be
      // read from — see the function comment above.
      const eventField = isStandalone ? null : (principal && principal.field) || r.field;

      if (isStandalone) {
        const backend = principal.backend || 'unknown';
        const bucket = standaloneByBackend.get(backend) || { backend, calls: 0, denied: 0 };
        bucket.calls += 1;
        if (denied) bucket.denied += 1;
        standaloneByBackend.set(backend, bucket);
      } else {
        // The workspace's bucket was already seeded from principals above; a call from a
        // workspace with no registered (non-standalone) principal at all is the one case that
        // still needs creating one here.
        const fieldBucket = byFieldMap.get(eventField) || {
          field: eventField,
          fieldPath: eventField === r.field ? r.fieldPath : null,
          calls: 0,
          denied: 0,
          principalCount: 0,
        };
        fieldBucket.calls += 1;
        if (denied) fieldBucket.denied += 1;
        byFieldMap.set(eventField, fieldBucket);
      }

      const name = principalDisplayName(principal, e.principalId);
      const bucketLabel = isStandalone ? `standalone:${principal.backend || 'unknown'}` : eventField;
      const key = `${name}\u0000${bucketLabel}`;
      const entry = byPrincipalMap.get(key) || {
        name,
        field: isStandalone ? null : eventField,
        standalone: isStandalone,
        backend: isStandalone ? principal.backend || 'unknown' : null,
        calls: 0,
        denied: 0,
      };
      entry.calls += 1;
      if (denied) entry.denied += 1;
      byPrincipalMap.set(key, entry);
    }
  }

  const byField = [...byFieldMap.values()].sort((a, b) => b.calls - a.calls);
  const byPrincipal = [...byPrincipalMap.values()].sort((a, b) => b.calls - a.calls);
  const standaloneEntries = [...standaloneByBackend.values()].sort((a, b) => b.calls - a.calls);
  const standaloneCalls = standaloneEntries.reduce((sum, b) => sum + b.calls, 0);
  const standaloneDenied = standaloneEntries.reduce((sum, b) => sum + b.denied, 0);

  return {
    fields: reads.map((r) => ({ field: r.field, fieldPath: r.fieldPath, reachable: r.reachable, error: r.error || null })),
    totals: { ...totals, denialRate: totals.calls === 0 ? 0 : totals.denied / totals.calls },
    byField,
    byPrincipal,
    standalone: { calls: standaloneCalls, denied: standaloneDenied, byBackend: standaloneEntries },
  };
}

module.exports = { FIELDS_ROOT, THIS_FIELD_NAME, discoverFieldDirs, readField, listFields, summary };
