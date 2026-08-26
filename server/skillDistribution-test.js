'use strict';

// Unit test for server/skillDistribution.js's reconcile — the node side of fleet skill distribution.
//
// Driven against a STUBBED central and a STUBBED skills module (a virtual set of installed slugs),
// so it needs no Postgres, no HTTP and no real skill directories. What it pins is the three things
// that would be a data-loss or clobber bug if they regressed:
//   1. a distributed skill missing from a target gets installed;
//   2. a skill this node previously installed and central no longer distributes gets removed;
//   3. a skill a HUMAN added (never in this node's manifest) is NEVER removed.

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

// A throwaway data dir so the manifest (managed-skills.json) does not touch a real install. Set
// BEFORE requiring config/skillDistribution, which resolve DATA_DIR at load time.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'windrow-skilldist-'));
process.env.WINDROW_DATA_DIR = TMP;
process.env.WINDROW_CENTRAL_URL = 'https://central.example'; // so syncOnce does not early-return
process.env.WINDROW_NO_ENV_FILE = '1';

const skills = require('./skills');
const policyClient = require('./policy/policyClient');
const dist = require('./skillDistribution');

// ---- the virtual disk: which (targetId, slug) SKILL.md files "exist" -------------------------
const disk = new Set(); // `${targetId}:${slug}`
const TARGET = 't1';

skills.listWriteTargets = () => [{ id: TARGET, label: 'test', path: path.join(TMP, 'skills'), exists: true }];
skills.slugify = (name) => String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
skills.presenceByTarget = (name) => {
  const slug = skills.slugify(name);
  return [{ id: TARGET, present: disk.has(`${TARGET}:${slug}`) }];
};
const created = [];
const removed = [];
skills.createSkill = ({ name, targetIds }) => {
  const slug = skills.slugify(name);
  for (const id of targetIds) disk.add(`${id}:${slug}`);
  created.push(slug);
  return { slug, written: targetIds };
};
skills.removeSkill = ({ name }) => {
  const slug = skills.slugify(name);
  for (const key of [...disk]) if (key.endsWith(`:${slug}`)) disk.delete(key);
  removed.push(slug);
  return { slug, removed: [TARGET] };
};

// ---- the stubbed central -----------------------------------------------------------------------
let centralSkills = [];
policyClient.centralRequest = async (method, pathname) => {
  assert.strictEqual(method, 'GET');
  assert.ok(pathname.includes('/api/policy/skills'), 'installer fetches the distributed-skills endpoint');
  return { skills: centralSkills };
};

async function main() {
  // Round 1: one distributed, one not. Only the distributed one is installed.
  centralSkills = [
    { id: 'c1', kind: 'skill', name: 'code-review', description: 'review a diff', distribute: true },
    { id: 'c2', kind: 'skill', name: 'dataviz', description: 'charts', distribute: false },
  ];
  let r = await dist.syncOnce();
  assert.deepStrictEqual(created, ['code-review'], 'the distributed skill is installed');
  assert.ok(disk.has(`${TARGET}:code-review`), 'its SKILL.md now exists on the target');
  assert.ok(!disk.has(`${TARGET}:dataviz`), 'the undistributed skill is not installed');
  assert.strictEqual(r.removed.length, 0, 'nothing removed on the first sync');
  console.log('  ok  a distributed skill is installed; an undistributed one is not');

  // Round 2: re-run with no change — idempotent, no second write (SKILL.md already present).
  created.length = 0;
  await dist.syncOnce();
  assert.deepStrictEqual(created, [], 're-syncing an already-installed skill writes nothing');
  console.log('  ok  reconcile is idempotent — a present SKILL.md is not rewritten');

  // Round 3: a human drops a skill onto the disk that central never distributed. It is NOT in the
  // manifest, so it must survive every future sync.
  disk.add(`${TARGET}:my-local-skill`);

  // Round 4: central stops distributing code-review. The node removes what IT installed — and only
  // that. The hand-added skill stays.
  removed.length = 0;
  centralSkills = [{ id: 'c1', kind: 'skill', name: 'code-review', description: 'review a diff', distribute: false }];
  await dist.syncOnce();
  assert.deepStrictEqual(removed, ['code-review'], 'the no-longer-distributed skill this node installed is removed');
  assert.ok(!disk.has(`${TARGET}:code-review`), 'its SKILL.md is gone');
  assert.ok(disk.has(`${TARGET}:my-local-skill`), 'a hand-added skill is never removed');
  console.log('  ok  removal only touches skills this node installed — hand-added skills survive');

  // The manifest reflects the final managed set (empty — nothing distributed now).
  const manifest = JSON.parse(fs.readFileSync(dist.MANIFEST_PATH, 'utf8'));
  assert.deepStrictEqual(manifest.slugs, [], 'the manifest tracks exactly what this node manages');
  console.log('  ok  the managed-skills manifest tracks only this node\'s installs');

  // Best-effort: requiring ./skills opened a SQLite handle in TMP, which can keep the file locked
  // on Windows. The assertions are what matter; a leftover temp dir is not a failure.
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* handle still open */ }
  console.log('\nskillDistribution: all assertions passed.');
}

main().catch((err) => {
  console.error('skillDistribution test failed:', err.stack || err.message);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(1);
});
