// Central skills management: skills are catalog-only, not governed (docs/design/skill-mcp-governance.md
// §0 — no grants, no usage tracking), but a human still needs one place to add a skill across every
// provider's skill directory instead of hand-writing a SKILL.md per provider. This module is that
// write path; server/discovery/scan.js stays the read path (it finds whatever landed here, plus
// anything a human dropped in by hand).
const fs = require('fs');
const path = require('path');
const store = require('./store');

/**
 * One entry per provider location a skill can be written into — server/store.js's
 * `discovery_sources` table, filtered to enabled, labeled 'skill_dir' rows marked writable
 * (excludes agy's installed-plugins dir, which holds whole plugin bundles rather than a single
 * SKILL.md, and excludes any unlabeled row so this page shows named providers, not raw paths —
 * see store.listSkillWriteTargets()'s doc comment). This used to be its own hardcoded list, kept
 * in sync with config.discoveryPaths() by hand; now it's the same table the Sources page edits and
 * server/discovery/scan.js reads, so an admin's edit there — adding a directory, renaming a label,
 * disabling one — shows up here without a second place to update.
 */
function writeTargets() {
  return store.listSkillWriteTargets().map((source) => ({
    id: source.id,
    label: source.label,
    path: source.path,
  }));
}

function listWriteTargets() {
  return writeTargets().map((t) => ({ ...t, exists: fs.existsSync(t.path) }));
}

/** Directory-safe slug for a skill name — matches how SKILL.md's own folder convention works. */
function slugify(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function skillMdContent(name, description) {
  const lines = ['---', `name: ${name}`];
  if (description) lines.push(`description: ${description}`);
  lines.push('---', '', `# ${name}`, '', description || '');
  return lines.join('\n') + '\n';
}

class InvalidSkillError extends Error {}

/**
 * Writes SKILL.md (under `<targetDir>/<slug>/SKILL.md`) into every requested target. Returns the
 * list of targets actually written to — a target whose directory can't be created (permissions,
 * a bad path) is skipped rather than failing the whole request, since the others may still matter.
 */
function createSkill({ name, description, targetIds }) {
  if (!name || !String(name).trim()) throw new InvalidSkillError('name is required');
  const slug = slugify(name);
  if (!slug) throw new InvalidSkillError('name must contain at least one letter or number');
  if (!Array.isArray(targetIds) || targetIds.length === 0) {
    throw new InvalidSkillError('at least one target provider is required');
  }
  const all = writeTargets();
  const targets = all.filter((t) => targetIds.includes(t.id));
  if (targets.length === 0) throw new InvalidSkillError('no matching target provider');

  const written = [];
  const content = skillMdContent(name.trim(), description ? String(description).trim() : '');
  for (const target of targets) {
    const skillDir = path.join(target.path, slug);
    try {
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf8');
      written.push(target.id);
    } catch {
      // Skipped — see doc comment above.
    }
  }
  return { slug, written };
}

/** Removes `<targetDir>/<slug>/` from every requested target. Missing dirs are a no-op, not an error. */
function removeSkill({ name, targetIds }) {
  const slug = slugify(name);
  const all = writeTargets();
  const targets = all.filter((t) => !targetIds || targetIds.includes(t.id));
  const removed = [];
  for (const target of targets) {
    const skillDir = path.join(target.path, slug);
    if (!fs.existsSync(skillDir)) continue;
    try {
      fs.rmSync(skillDir, { recursive: true, force: true });
      removed.push(target.id);
    } catch {
      // Skipped, same reasoning as createSkill.
    }
  }
  return { slug, removed };
}

/** Which write targets currently have this skill's SKILL.md on disk — for the manage view. */
function presenceByTarget(name) {
  const slug = slugify(name);
  return writeTargets().map((t) => ({
    ...t,
    present: fs.existsSync(path.join(t.path, slug, 'SKILL.md')),
  }));
}

module.exports = { listWriteTargets, createSkill, removeSkill, presenceByTarget, slugify, InvalidSkillError };
