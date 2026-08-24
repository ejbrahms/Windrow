'use strict';
// Watches each backend's own hook-config file (~/.claude/settings.json,
// ~/.gemini/config/hooks.json — server/config.js's hookInstallPaths) for the PreToolUse/
// PostToolUse entries server/providers.js installed there, and puts them back if they go
// missing.
//
// Why this needs to exist at all: every check in server/hooks/lib.js — grant lookups, risk
// tiers, fail-closed, the signed caches — only runs because the harness actually invokes
// pre-tool-use.js/post-tool-use.js before and after a tool call. That invocation is wired up by
// one JSON entry in a config file the harness reads off local disk. Anyone with write access to
// that file — a careless hand-edit, a compromised skill, an uninstall script from something else
// — can delete the entry and every governed tool call goes back to running ungoverned, with
// nothing in server/hooks/* ever running to notice or log it. This is the piece that watches the
// wiring from *outside* that blind spot.
//
// Event-driven, not a timer poll: each config file's parent directory gets an `fs.watch`
// (built into Node — no new dependency), so a tamper attempt is caught and repaired within a
// debounce window (default 250ms) of the write, not up to a whole poll interval later. Watching
// the *directory* rather than the file itself is deliberate — most editors/scripts "save" by
// unlink+rename (a new inode), which silently ends a watch placed on the old file handle on both
// Windows and POSIX; a directory watch survives that and is filtered back down to just this
// adapter's filename.
//
// `fs.watch` is still not a complete guarantee (docs: "not 100% consistent across platforms, and
// in some situations unavailable" — network filesystems, a directory that doesn't exist yet, a
// watch that silently dies). A long-interval fallback poll (default 5 min, well above the
// sub-second debounce window this would otherwise rely on alone) is kept as a safety net under
// the event-driven path, and also covers the moment-of-startup case (config already tampered
// before this process existed) and retries starting a watch on any directory that didn't exist
// yet the first time.
//
// Deliberately does not force-install an adapter nobody turned on (see providers.js's
// checkAndRepair / wasEverInstalled) — this repairs drift, it doesn't opt a workspace into a
// backend it never asked for.

const fs = require('fs');
const path = require('path');
const { checkAndRepair } = require('./providers');
const { REPO_ROOT, hookInstallPaths } = require('./config');

const DEBOUNCE_MS = Number(process.env.HOOK_WATCH_DEBOUNCE_MS) || 250;
const FALLBACK_POLL_MS = Number(process.env.HOOK_WATCH_FALLBACK_INTERVAL_MS) || 5 * 60_000;
const MAX_LOG_ENTRIES = 200;

function runCheck(store, { repoRoot } = {}) {
  const state = store.getHookIntegrity();
  const everInstalled = state.everInstalled || {};
  let results;
  try {
    results = checkAndRepair(repoRoot, everInstalled);
  } catch (err) {
    // Best-effort: a failed check just means the config file's state is unknown until the next
    // watch event or fallback tick, never a reason to take the server down.
    console.error('[hook-watcher] check failed:', err.message);
    return [];
  }

  const nextEverInstalled = { ...everInstalled };
  const newLogEntries = [];
  for (const r of results) {
    if (r.installedNow) nextEverInstalled[r.id] = true;
    if (r.tampered) {
      const entry = {
        ts: new Date().toISOString(),
        provider: r.id,
        configPath: r.configPath,
        reason: r.parseError ? `config unreadable: ${r.parseError}` : 'hook entries missing from config',
        repaired: r.repaired,
      };
      newLogEntries.push(entry);
      console.error(
        `[hook-watcher] TAMPER DETECTED — ${r.label} hook wiring missing from ${r.configPath}` +
          (r.repaired ? ' — restored.' : ' — restore FAILED, governance is bypassed for this backend until fixed.')
      );
    }
  }

  if (newLogEntries.length > 0) {
    const log = [...newLogEntries, ...(state.log || [])].slice(0, MAX_LOG_ENTRIES);
    store.setHookIntegrity({ everInstalled: nextEverInstalled, log });
  } else if (JSON.stringify(nextEverInstalled) !== JSON.stringify(everInstalled)) {
    store.setHookIntegrity({ everInstalled: nextEverInstalled, log: state.log || [] });
  }

  return newLogEntries;
}

/**
 * Starts the watchdog: an fs.watch on each configured adapter's config directory (filtered to
 * that adapter's own filename), debounced into a single checkAndRepair pass per burst of writes,
 * plus a slow fallback poll and periodic retry of any directory whose watch couldn't be
 * established yet (doesn't exist, transient error). Returns a `stop()` function that closes every
 * watcher and clears both timers.
 */
function startHookWatcher(store, { repoRoot = REPO_ROOT, debounceMs = DEBOUNCE_MS, fallbackIntervalMs = FALLBACK_POLL_MS, onTamper = null } = {}) {
  // Told about a tamper the moment one is detected, so the fleet learns within a debounce window
  // rather than at the reporter's next slow tick — server/nodeHealth.js, and
  // docs/design/dashboard-placement.md item 2. Passed in rather than required here for the reason
  // `onFired` is passed to the alert engine: the watcher's job is the config file on this disk,
  // and a watcher that knew how to reach central would be two responsibilities in one file.
  //
  // Wrapped so a reporter that throws cannot take down the repair loop that just succeeded. A
  // tamper that was fixed locally and not reported is a visibility gap; a repair loop that died is
  // a governance one.
  const announce = (entries) => {
    if (!onTamper || !entries.length) return;
    try {
      const result = onTamper(entries);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (err) {
      console.error('[hook-watcher] tamper notification failed:', err.message);
    }
  };
  let debounceTimer = null;
  const scheduleCheck = () => {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      announce(runCheck(store, { repoRoot }));
    }, debounceMs);
    debounceTimer.unref();
  };

  const configPaths = Object.values(hookInstallPaths(repoRoot)).filter(Boolean);
  const watchers = new Map(); // dir -> FSWatcher

  const tryWatch = (dir) => {
    if (watchers.has(dir)) return;
    try {
      const watcher = fs.watch(dir, (eventType, filename) => {
        // filename is null on some platforms/events (e.g. certain network filesystems) — when
        // that happens just recheck rather than trying to filter, since we can't tell what
        // changed. Otherwise only react to writes touching one of *this* directory's watched
        // config files, not unrelated files an editor also happens to touch there.
        if (filename && !configPaths.some((p) => path.basename(p) === filename)) return;
        scheduleCheck();
      });
      watcher.unref();
      watcher.on('error', (err) => {
        // A watch can die mid-run (directory removed, handle invalidated). Drop it so the
        // fallback poll's retry loop re-establishes it once the directory is there again.
        console.error(`[hook-watcher] watch on ${dir} failed:`, err.message);
        watchers.delete(dir);
      });
      watchers.set(dir, watcher);
    } catch (err) {
      // Most commonly ENOENT — the config's parent directory (e.g. ~/.gemini/config/) doesn't
      // exist yet because that backend was never installed. Not an error; the fallback poll
      // retries this on its own interval so a watch starts the moment the directory shows up.
    }
  };

  const dirsToWatch = [...new Set(configPaths.map((p) => path.dirname(p)))];
  for (const dir of dirsToWatch) tryWatch(dir);

  // One immediate synchronous check so a server restart catches tampering that happened while it
  // was down, then a slow fallback poll for anything fs.watch can't be trusted to catch on its
  // own (missed events, a watch that silently died, a directory that didn't exist at startup).
  announce(runCheck(store, { repoRoot }));
  const fallbackTimer = setInterval(() => {
    for (const dir of dirsToWatch) tryWatch(dir); // re-establish any watch that died or was pending
    announce(runCheck(store, { repoRoot }));
  }, fallbackIntervalMs);
  fallbackTimer.unref();

  return () => {
    clearInterval(fallbackTimer);
    if (debounceTimer) clearTimeout(debounceTimer);
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  };
}

module.exports = { startHookWatcher, runCheck };
