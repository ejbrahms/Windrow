// Real filesystem discovery: finds SKILL.md files under a set of real directories on this
// machine and parses their frontmatter. See docs/design/api-contract.md "Discovery (v1)".
const fs = require('fs');
const path = require('path');
const os = require('os');
const store = require('../store');

/** Recursively find every SKILL.md under `root`. Missing/unreadable dirs yield []. */
function findSkillMdFiles(root) {
  const results = [];
  if (!fs.existsSync(root)) return results;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir (permissions, race) — skip, don't fail the whole scan
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name === 'SKILL.md') {
        results.push(full);
      }
    }
  }
  return results;
}

/**
 * SKILL.md frontmatter is plain, non-nested `key: value` lines between a pair of `---` fences —
 * no YAML library needed. Anything else in the file is ignored.
 */
function parseFrontmatter(content) {
  const lines = content.split(/\r?\n/);
  if (lines[0].trim() !== '---') return {};
  const fm = {};
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') break;
    const m = lines[i].match(/^([A-Za-z_][\w-]*):\s?(.*)$/);
    if (m) fm[m[1]] = m[2].trim();
  }
  return fm;
}

function skillCandidateFromFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const fm = parseFrontmatter(content);
  const dirName = path.basename(path.dirname(filePath));
  return {
    kind: 'skill',
    name: fm.name || dirName,
    owner: 'platform',
    // SKILL.md carries no risk-tier field, and we're not going to guess at each skill's blast
    // radius from its description. Default conservative (mutating, not read_only) until a human
    // curates it — least-privilege means an unclassified capability should not be assumed safe.
    riskTier: 'mutating',
    description: fm.description || null,
    source: 'filesystem',
  };
}

/**
 * The manually configurable scan roots, in priority order (oldest-added first — first occurrence
 * of a name wins). Backed by the `discovery_sources` table (server/store.js), which an admin
 * curates from the Sources page; only enabled rows are scanned. Seeded once from server/config.js's
 * defaults (SKILL_DIRS env var + the three standard skill dirs) the first time the table is empty,
 * so an unconfigured server behaves exactly as it did before manual configuration existed.
 */
function defaultSkillDirs() {
  return store.listEnabledDiscoverySourcePaths();
}

/** Every installed plugin's skills/ dir under the marketplace clone — always scanned. */
function pluginSkillDirs() {
  const home = os.homedir();
  const marketplacesRoot = path.join(home, '.claude', 'plugins', 'marketplaces');
  const roots = [];
  if (!fs.existsSync(marketplacesRoot)) return roots;
  for (const marketplace of fs.readdirSync(marketplacesRoot, { withFileTypes: true })) {
    if (!marketplace.isDirectory()) continue;
    const base = path.join(marketplacesRoot, marketplace.name);
    for (const group of ['plugins', 'external_plugins']) {
      const groupDir = path.join(base, group);
      if (!fs.existsSync(groupDir)) continue;
      for (const plugin of fs.readdirSync(groupDir, { withFileTypes: true })) {
        if (!plugin.isDirectory()) continue;
        roots.push(path.join(groupDir, plugin.name, 'skills'));
      }
    }
  }
  return roots;
}

/** Scans every real skill root and returns deduped candidate capabilities. */
function scanFilesystem() {
  const dirs = [...defaultSkillDirs(), ...pluginSkillDirs()];
  const seenNames = new Set();
  const candidates = [];
  for (const dir of dirs) {
    for (const file of findSkillMdFiles(dir)) {
      const candidate = skillCandidateFromFile(file);
      if (seenNames.has(candidate.name)) continue; // configured roots outrank the plugin clone
      seenNames.add(candidate.name);
      candidates.push(candidate);
    }
  }
  return candidates;
}

module.exports = { scanFilesystem, parseFrontmatter, findSkillMdFiles, defaultSkillDirs, pluginSkillDirs };
