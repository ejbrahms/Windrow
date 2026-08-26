'use strict';

// The node side of fleet skill distribution — the counterpart to central's GET /api/policy/skills
// (server/central/policyRoutes.js) and the `distribute` flag (migration 14).
//
// WHAT IT DOES. On a timer, and once at boot, it asks central which skills are marked for the fleet
// and makes this machine's skill directories match: it writes a SKILL.md for every distributed skill
// that is missing, and removes the ones it previously installed that are no longer distributed. A
// user on this node then just has the skill, without finding and installing it themselves — which is
// the whole point of a central skill catalog.
//
// WHY IT IS ITS OWN CHANNEL, not part of the policy pull. Distribution is PROVISIONING, not
// enforcement: a skill has no call-time choke point (docs/design/skill-mcp-governance.md §0), so it
// is never in a grant, never in the deny-list, and does not belong in the version-bearing policy
// delta the hot path reads. It rides a separate, idempotent reconcile — the same shape as the
// deny-list riding every response: fetch the full desired set, make the disk match, no diffing.
//
// SAFE BY CONSTRUCTION. It only ever writes a skill central marked `distribute`, and only removes a
// slug THIS process previously installed (tracked in managed-skills.json) — a skill a human dropped
// in by hand is never touched, because its slug is not in the manifest. And it writes a missing
// SKILL.md rather than overwriting an existing one, so a locally-edited copy is left alone.
//
// A NO-OP WITHOUT A CENTRAL. Like server/usageShipper.js and server/policy/policyClient.js, it does
// nothing on a standalone install (no WINDROW_CENTRAL_URL) — there is no fleet library to pull from.

const fs = require('fs');
const path = require('path');
const { envCompat, DATA_DIR } = require('./config');
const skills = require('./skills');
const policyClient = require('./policy/policyClient');

const CENTRAL_URL = envCompat('CENTRAL_URL') || null;
const SKILLS_PATH = envCompat('CENTRAL_SKILLS_PATH') || '/api/policy/skills';
// Skill distribution is not latency-critical the way a revocation is — a new skill appearing a minute
// later is fine — so this polls slower than the 30s policy poll by default.
const SYNC_INTERVAL_MS = Number(envCompat('SKILL_SYNC_INTERVAL_MS')) || 60_000;
// The record of what THIS node installed, so removal never touches a hand-added skill. One flat list
// of slugs; the names live in the SKILL.md files themselves.
const MANIFEST_PATH = path.join(DATA_DIR, 'managed-skills.json');

let timer = null;
let running = false;

function loadManifest() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    return Array.isArray(parsed.slugs) ? parsed.slugs : [];
  } catch {
    return [];
  }
}

function saveManifest(slugs) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ slugs: [...new Set(slugs)].sort() }, null, 2), 'utf8');
  } catch (err) {
    console.error('[skill-distribution] could not write the managed-skills manifest:', err.message);
  }
}

/**
 * One reconcile: fetch the fleet's distributed skills and make this machine match.
 *
 * Exported so a test can drive it against a fake central without a timer, and so an admin route
 * could trigger it on demand later.
 */
async function syncOnce() {
  if (!CENTRAL_URL) return { installed: [], removed: [], skipped: 'no-central' };
  const resp = await policyClient.centralRequest('GET', SKILLS_PATH);
  const all = (resp && Array.isArray(resp.skills)) ? resp.skills : [];
  const desired = all.filter((s) => s && s.distribute && s.name);

  // Every writable skill directory this node has (the same targets the manual Skills page writes to).
  const targets = skills.listWriteTargets().filter((t) => t.exists);
  const targetIds = targets.map((t) => t.id);

  const previous = new Set(loadManifest());
  const managed = new Set();
  const installed = [];

  for (const skill of desired) {
    const slug = skills.slugify(skill.name);
    if (!slug) continue;
    managed.add(slug);
    if (targetIds.length === 0) continue;
    // Write only where the SKILL.md is missing — idempotent, and never clobbers a local edit.
    const presence = skills.presenceByTarget(skill.name);
    const missing = targetIds.filter((id) => {
      const p = presence.find((x) => x.id === id);
      return p && !p.present;
    });
    if (missing.length > 0) {
      const result = skills.createSkill({ name: skill.name, description: skill.description || '', targetIds: missing });
      if (result.written.length > 0) installed.push(slug);
    }
  }

  // Remove what THIS node installed that is no longer distributed — never a hand-added skill, whose
  // slug was never in the manifest.
  const removed = [];
  for (const slug of previous) {
    if (managed.has(slug)) continue;
    skills.removeSkill({ name: slug });
    removed.push(slug);
  }

  saveManifest([...managed]);
  return { installed, removed, desired: desired.length, targets: targetIds.length };
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const result = await syncOnce();
    if (result.installed?.length || result.removed?.length) {
      console.log(
        `[skill-distribution] synced fleet skills: +${result.installed.length} installed, `
        + `-${result.removed.length} removed (${result.desired} distributed, ${result.targets} targets).`
      );
    }
  } catch (err) {
    // Best-effort and quiet: a central that is briefly unreachable is the poll channel's problem to
    // retry, not a reason to shout every minute. The skills already on disk keep working.
    if (process.env.WINDROW_DEBUG) console.warn('[skill-distribution] sync failed:', err.message);
  } finally {
    running = false;
  }
}

/**
 * Start reconciling distributed skills onto this node. A no-op with no central configured, for the
 * same reason the shipper and policy client are — there is no fleet library to install from.
 */
function startSkillDistribution() {
  if (timer) return timer;
  if (!CENTRAL_URL) return null;
  console.log(
    `[skill-distribution] installing fleet skills from ${new URL(SKILLS_PATH, CENTRAL_URL).href} `
    + `every ${SYNC_INTERVAL_MS / 1000}s.`
  );
  // Soon after boot, but not synchronously in the listen callback — the policy client's first pull
  // and credential resolve should get the socket first.
  const kickoff = setTimeout(tick, 3_000);
  if (typeof kickoff.unref === 'function') kickoff.unref();
  timer = setInterval(tick, SYNC_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

function stopSkillDistribution() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startSkillDistribution, stopSkillDistribution, syncOnce, MANIFEST_PATH };
