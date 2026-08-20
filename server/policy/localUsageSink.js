'use strict';

// Local (node-authoritative) implementation of the usageSink contract — see ./index.js.
//
// The sink is the *write* half of the seam: everything this node observed and has to account for.
// Today an observation is written straight to the node's SQLite and read back from the same place,
// so the sink is also where the read-back lives — the dashboard's usage summary, the audit log and
// the chain verifier are all reading the node's own record of what it shipped. Keeping the reads
// here rather than on policyStore is what makes phase 3's shadow mode a one-file change: the sink
// gains a second destination and the readers keep reading the local record.
//
// Delegates are thin on purpose: phase 2 (docs/design/global-identity-and-central-db.md §2.7) is a
// pure refactor and must not change behaviour.

const store = require('../store');

module.exports = {
  // --- node identity --------------------------------------------------------
  // The chain is keyed (nodeId, seq) since phase 1, so the node's own id is part of the sink's
  // surface rather than something a reader digs out of the database.
  nodeId: (...args) => store.nodeId(...args),
  listChainHeads: (...args) => store.listChainHeads(...args),

  // --- usage events ---------------------------------------------------------
  recordUsageEvent: (...args) => store.insertUsageEvent(...args),
  patchUsageEvent: (...args) => store.patchUsageEvent(...args),
  listUsageEvents: (...args) => store.listUsageEvents(...args),
  findUsageEvent: (...args) => store.findUsageEvent(...args),
  verifyUsageEventChain: (...args) => store.verifyUsageEventChain(...args),

  // --- audit ----------------------------------------------------------------
  // Audit rows record who changed policy, not who called a tool, but they are observations of this
  // node all the same and travel the same way — append-only, shipped up, never read on a hot path.
  recordAuditEntry: (...args) => store.insertAuditEntry(...args),
  listAuditEntries: (...args) => store.listAuditEntries(...args),

  // --- native tool observations ---------------------------------------------
  // Written by server/nativeObservations.js off the hook path; app.js only ever reads them.
  listNativeToolEvents: (...args) => store.listNativeToolEvents(...args),
  summarizeNativeToolEvents: (...args) => store.summarizeNativeToolEvents(...args),
  summarizeNativeToolEventsByTool: (...args) => store.summarizeNativeToolEventsByTool(...args),
  summarizeNativeToolEventsByPrincipal: (...args) => store.summarizeNativeToolEventsByPrincipal(...args),
};
