'use strict';

// The policyStore / usageSink seam — phase 2 of docs/design/global-identity-and-central-db.md §2.7.
//
//   policyStore  reads (and, while the node is still authoritative, writes) POLICY:
//                capabilities, principals, grants, approvals. Phase 4 flips authority for this
//                half to central and the node keeps a replica.
//   usageSink    writes OBSERVATIONS — usage events, audit rows — and reads back this node's own
//                record of them. Phase 3 gives it a second destination (shadow mode) without
//                moving authority anywhere.
//
// Why the indirection, given both halves currently just call server/store.js: server/app.js had
// ~50 direct `store.*` call sites spread over 2000 lines, and every later phase of the central-DB
// work needs to change *where* policy is read from and *where* usage is written to. With the seam
// in place that is a change to the two adapters beside this file; without it, it is a change to
// fifty routes. This phase ships no behaviour change at all — that is the point of doing it on its
// own rather than inside phase 3.
//
// What is deliberately NOT behind the seam, and stays a direct `store.*` call in app.js:
//   * discovery sources and discovery state, packages state, hook integrity — node-local
//     configuration describing *this machine's* filesystem. Central has no opinion on it.
//   * node enrollment (server/enrollment/**) — the credential the node uses to reach central, so
//     it cannot itself be fetched from central.
//   * store.load()/store.save() — the whole-database read/replace pair that phase 0 exists to
//     remove. Routing it through the seam would give a lost-write race a longer life; discovery is
//     its only remaining caller in app.js and it should shrink to narrow upserts, not move.
//
// Rebinding: setBackends() lets a test or a later deployment mode swap either half. It replaces the
// binding for every subsequent call — app.js holds a reference to the module object below, not to
// the adapters, so a swap is picked up by routes that were required long before it.

const localPolicyStore = require('./localPolicyStore');
const localUsageSink = require('./localUsageSink');

/** @type {typeof localPolicyStore} */
let policyStoreImpl = localPolicyStore;
/** @type {typeof localUsageSink} */
let usageSinkImpl = localUsageSink;

// Facades, not the adapters themselves: callers capture `policyStore` once at require() time, so
// the object they hold has to survive a later setBackends(). Each key resolves against whatever is
// bound at the moment it is used, not at the moment it was required.
//
// Methods come back as a wrapper that dispatches on call, so a swap mid-flight is honoured and the
// adapter still receives itself as `this`. Everything else — the error classes — comes back
// untouched: wrapping a constructor would break the `instanceof` checks that are the whole reason
// callers can see it.
const isConstructor = (value) => /^class[\s{]/.test(Function.prototype.toString.call(value));

// `reference` is the local adapter: it decides which keys exist and which of them are methods. A
// replacement has to match that shape (assertImplements) rather than redefine it.
function facade(get, reference) {
  const out = {};
  for (const [key, localValue] of Object.entries(reference)) {
    const passThrough = typeof localValue !== 'function' || isConstructor(localValue);
    Object.defineProperty(out, key, {
      enumerable: true,
      get: passThrough ? () => get()[key] : () => (...args) => get()[key](...args),
    });
  }
  return out;
}

const policyStore = facade(() => policyStoreImpl, localPolicyStore);
const usageSink = facade(() => usageSinkImpl, localUsageSink);

/**
 * Swap either half of the seam. Pass only the half you mean to replace. A replacement must
 * implement every key of the local adapter it stands in for — checked here rather than left to
 * surface as an undefined-is-not-a-function three routes deep.
 */
function setBackends({ policyStore: nextPolicy, usageSink: nextUsage } = {}) {
  if (nextPolicy) {
    assertImplements('policyStore', nextPolicy, localPolicyStore);
    policyStoreImpl = nextPolicy;
  }
  if (nextUsage) {
    assertImplements('usageSink', nextUsage, localUsageSink);
    usageSinkImpl = nextUsage;
  }
}

/** Restore the node-local SQLite adapters. */
function resetBackends() {
  policyStoreImpl = localPolicyStore;
  usageSinkImpl = localUsageSink;
}

function assertImplements(label, candidate, reference) {
  const missing = Object.keys(reference).filter((key) => candidate[key] === undefined);
  if (missing.length > 0) {
    throw new Error(`${label} replacement is missing: ${missing.join(', ')}`);
  }
}

module.exports = { policyStore, usageSink, localPolicyStore, localUsageSink, setBackends, resetBackends };
