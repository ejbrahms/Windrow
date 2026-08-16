// Backfills real historical skill usage from Claude Code's own local record, so the catalog
// shows genuinely-used capabilities even when discovery can't find their SKILL.md (built-in
// skills aren't on disk). See docs/design/api-contract.md "Discovery (v1)".
const fs = require('fs');
const path = require('path');
const { userHomeDir } = require('../config');

/** Reads the real ~/.claude.json skillUsage/pluginUsage objects. Missing/unreadable -> empty. */
function loadClaudeUsageHistory() {
  const configPath = path.join(userHomeDir(), '.claude.json');
  if (!fs.existsSync(configPath)) return { skillUsage: {}, pluginUsage: {} };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return { skillUsage: {}, pluginUsage: {} };
  }
  return { skillUsage: parsed.skillUsage || {}, pluginUsage: parsed.pluginUsage || {} };
}

/** "anthropic-skills:skill-creator" -> "skill-creator" */
function stripMarketplacePrefix(name) {
  const idx = name.indexOf(':');
  return idx === -1 ? name : name.slice(idx + 1);
}

/**
 * Mutates `candidates` in place: attaches `realUsage` to any candidate whose name matches a
 * skillUsage/pluginUsage entry, and appends a `usage-history-only` candidate for any skillUsage
 * entry with no match (Claude Code's built-in skills — real and used, just not backed by a file
 * we can see). `pluginUsage` keys are plugin package ids (e.g. "anthropic-skills@inline"), not
 * skill names — real, but a different kind of thing — so a pluginUsage entry only ever backfills
 * an existing match by name; it never manufactures a fake `kind: "skill"` entry. Returns the same
 * array for convenience.
 */
function backfillRealUsage(candidates) {
  const { skillUsage, pluginUsage } = loadClaudeUsageHistory();
  const byName = new Map(candidates.map((c) => [c.name, c]));

  function toRealUsage(usage) {
    if (typeof usage.usageCount !== 'number' || typeof usage.lastUsedAt !== 'number') return null;
    return { usageCount: usage.usageCount, lastUsedAt: new Date(usage.lastUsedAt).toISOString() };
  }

  for (const [rawName, usage] of Object.entries(skillUsage)) {
    const realUsage = toRealUsage(usage);
    if (!realUsage) continue;
    const name = stripMarketplacePrefix(rawName);
    const existing = byName.get(name);
    if (existing) {
      existing.realUsage = realUsage;
    } else {
      const candidate = {
        kind: 'skill',
        name,
        owner: 'platform',
        riskTier: 'mutating',
        description: null,
        source: 'usage-history-only',
        realUsage,
      };
      candidates.push(candidate);
      byName.set(name, candidate);
    }
  }

  // pluginUsage: backfill onto a known match only — never invent a new capability from it, since
  // its keys name plugin packages, not individual skills or tools.
  for (const [rawName, usage] of Object.entries(pluginUsage)) {
    const realUsage = toRealUsage(usage);
    if (!realUsage) continue;
    const existing = byName.get(stripMarketplacePrefix(rawName));
    if (existing) existing.realUsage = realUsage;
  }

  return candidates;
}

module.exports = { backfillRealUsage, loadClaudeUsageHistory, stripMarketplacePrefix };
