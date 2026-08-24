#!/usr/bin/env node
'use strict';
// `npm run node:retire` — take this node out of the fleet without losing the audit it still owes.
//
// docs/design/dashboard-placement.md item 6. "Disposable" means destroyable at any moment, and at
// any moment this node's `usage_outbox` holds governed decisions that exist NOWHERE ELSE: they
// committed locally, they were queued for central, and central has not confirmed them. The design
// note counted eight on the machine it was written on. So `docker rm` on a node is not a safe
// operation and never was — either the outbox drains synchronously before a node can be retired,
// or retiring one silently deletes audit.
//
// THIS IS THAT COMMAND, and it is deliberately shaped as a gate rather than a cleanup:
//
//   it drains first and reports second. Nothing is deleted, ever — if the queue cannot be
//   delivered, this says so and EXITS NON-ZERO, so a script that pipes `npm run node:retire &&
//   docker rm` cannot destroy the machine while shipments are still outstanding. That composition
//   is the whole point; an exit code that ignored a stuck queue would make this decorative.
//
//   it also drains the native-observation queue, which since item 1 is a second stream with its
//   own cursor. Losing observations is a smaller loss than losing audit — they were never a
//   complete record — but it is still the loss the shipper exists to prevent, and a retire that
//   flushed one queue and not the other would be a half-answer.
//
// WHY IT RUNS THE DRAIN IN THIS PROCESS RATHER THAN ASKING THE SERVER TO. The server may already be
// stopped — retiring a machine usually means it is on its way out — and a command that only worked
// while the service was healthy would be unavailable in exactly the case it is needed. SQLite in
// WAL mode takes concurrent writers, so a running service draining at the same time costs at most a
// duplicate delivery, which central's ingest key throws away.

const path = require('path');

const store = require(path.join(__dirname, '..', 'server', 'store'));
const usageShipper = require(path.join(__dirname, '..', 'server', 'usageShipper'));
const nativeShipper = require(path.join(__dirname, '..', 'server', 'nativeShipper'));
const { reportNow: reportNodeHealth, startNodeHealthReporter } = require(path.join(__dirname, '..', 'server', 'nodeHealth'));

const USAGE = `Usage:
  npm run node:retire              drain everything this node owes central, then report
  npm run node:retire -- --check   report what is outstanding and drain nothing
  npm run node:retire -- --force   report, but exit 0 even with shipments undelivered

Exits non-zero when anything is still owed, so it composes:

  npm run node:retire && docker rm -f windrow-node

--force is for the case where the loss is a decision someone has made on purpose. It prints the
same numbers; it just stops them from stopping you.`;

const DEADLINE_MS = Number(process.env.WINDROW_RETIRE_DEADLINE_MS) || 120_000;

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * What this node currently owes central, from both queues AND UNDER EVERY ID IT HAS EVER HELD.
 *
 * docs/design/disposable-nodes.md §3's first correctness gap. This used to call
 * `store.usageOutboxStats()`, which scopes to the CURRENT nodeId. Rows queued under a previous one
 * — the drift that note measured as two `outbox_seq:` counters in one `kv` — were invisible to it,
 * so a machine still holding orphaned audit was told "nothing is owed. This node can be destroyed."
 *
 * ORPHANS ARE COUNTED SEPARATELY FROM THE CURRENT QUEUE, because they are a different problem with
 * a different remedy. The current queue can be drained: this process holds the credential for it.
 * An orphan cannot — central refuses a whole batch whose envelope names a node other than the
 * certificate's CN — so draining is not the answer, and attempting it would only produce a loop of
 * rejections. The answer is to say so, exit non-zero, and let a human decide.
 */
function outstanding() {
  const byNode = store.usageOutboxStatsByNode();
  const current = byNode.find((n) => n.deliverable) || { pending: 0, oldestEnqueuedAt: null };
  const orphans = byNode.filter((n) => !n.deliverable && n.pending > 0);
  const usage = store.usageOutboxStats();
  const native = store.nativeShipStats();
  const orphanPending = orphans.reduce((n, o) => n + o.pending, 0);
  return {
    usage: { pending: current.pending, oldest: current.oldestEnqueuedAt, lastError: usage.lastError || null },
    native: { pending: native.pending, oldest: native.oldest },
    orphans,
    orphanPending,
    total: current.pending + native.pending + orphanPending,
  };
}

function report(state, { prefix = '' } = {}) {
  console.log(`${prefix}usage shipments queued:      ${state.usage.pending}${state.usage.oldest ? ` (oldest ${state.usage.oldest})` : ''}`);
  console.log(`${prefix}native observations queued:  ${state.native.pending}${state.native.oldest ? ` (oldest ${state.native.oldest})` : ''}`);
  for (const orphan of state.orphans) {
    console.log(
      `${prefix}queued under ${orphan.nodeId}:  ${orphan.pending}`
      + `${orphan.oldestEnqueuedAt ? ` (oldest ${orphan.oldestEnqueuedAt})` : ''}`
      + "  << NOT DELIVERABLE under this node's credential"
    );
  }
}

async function main(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    return 0;
  }
  const check = argv.includes('--check');
  const force = argv.includes('--force');

  console.log(`Node ${store.nodeId()}, incarnation ${store.incarnation()}.`);
  const before = outstanding();
  report(before, { prefix: '  ' });

  if (!before.total) {
    console.log('\nNothing is owed to central. This node can be destroyed.');
    return 0;
  }
  if (check) {
    console.log(`\n${plural(before.total, 'item is', 'items are')} still owed to central. Run without --check to drain.`);
    return 1;
  }

  // Starting the shippers is what gives this process a transport and a credential; both are no-ops
  // without a central, in which case there is nothing queued to drain and the report above already
  // said so.
  usageShipper.startUsageShipper(store);
  nativeShipper.startNativeShipper(store);

  console.log('\nDraining. Nothing is deleted — a shipment central does not confirm stays queued.');
  const usageResult = await usageShipper.drainUntilEmpty({
    deadlineMs: DEADLINE_MS,
    onProgress: ({ drained, pending }) => console.log(`  usage: ${drained} delivered, ${pending} to go`),
  });
  if (usageResult.reason) console.log(`  usage: ${usageResult.reason}`);

  // The native queue has no equivalent deadline loop of its own — its drain already chases full
  // batches and stops on the first failure — so it is run until it stops making progress. A stuck
  // native queue must not hold the command open past the audit queue's own deadline: the audit is
  // the part that is irreplaceable.
  const nativeDeadline = Date.now() + DEADLINE_MS;
  for (;;) {
    const pendingBefore = store.nativeShipStats().pending;
    if (!pendingBefore || Date.now() > nativeDeadline) break;
    await nativeShipper.drain();
    const pendingAfter = store.nativeShipStats().pending;
    console.log(`  native: ${pendingBefore - pendingAfter} delivered, ${pendingAfter} to go`);
    if (pendingAfter >= pendingBefore) break; // no progress — central is not taking them
  }

  // One last health report, so the fleet's last word about this machine is the truth rather than
  // whatever it happened to say five minutes ago. Best-effort by nature: it is current state, and
  // a node about to be destroyed has no state worth retrying for.
  startNodeHealthReporter(store);
  await reportNodeHealth().catch(() => null);

  const after = outstanding();
  console.log('');
  report(after, { prefix: '  ' });

  if (!after.total) {
    console.log('\nEverything this node owed central has been delivered and confirmed. Safe to destroy.');
    return 0;
  }

  // The failure message is the whole value of this command, so it names what would actually be
  // lost rather than saying "some items remain".
  console.error(
    `\nNOT SAFE TO DESTROY — ${plural(after.usage.pending + after.orphanPending, 'governed decision is', 'governed decisions are')} `
      + `still queued for central and ${plural(after.native.pending, 'observation has', 'observations have')} not shipped.`
  );

  // Orphans get their own paragraph, because "fix the connection and run this again" is the one
  // remedy that will never work for them and is exactly what the message below tells an operator.
  if (after.orphanPending) {
    console.error(
      `\n${plural(after.orphanPending, 'governed decision is', 'governed decisions are')} queued under an id `
        + `this node no longer answers to: ${after.orphans.map((o) => `${o.nodeId} (${o.pending})`).join(', ')}.`
        + '\nCentral refuses a whole batch whose envelope names a node other than the certificate it was'
        + '\nsent with, so these cannot be shipped under the credential this machine holds now. They are the'
        + '\nresidue of a re-enrolment that minted a fresh id — which no longer happens'
        + '\n(docs/design/disposable-nodes.md §2.1), but which does not undo itself.'
        + '\n\nTwo ways out: re-enrol this machine under the old id and run this again, or accept the loss'
        + '\nwith --force. There is no third — re-keying them onto this node would change whose evidence'
        + '\nthey are, which is forgery even when it is the same machine.'
    );
  }
  if (after.usage.pending) {
    console.error(
      '\nThose usage events committed on this machine and exist NOWHERE ELSE. Destroying this node',
      '\ndestroys them, and central\'s copy of this node\'s stream will have a hole in it that nothing',
      '\nwill ever fill.'
    );
    if (after.usage.lastError) console.error(`\nLast delivery error: ${after.usage.lastError}`);
    console.error('\nFix the connection to central and run this again, or accept the loss with --force.');
  }
  return force ? 0 : 1;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    // Anything unexpected exits non-zero, for the reason the whole file exists: the caller may be
    // `&&`-chained to a `docker rm`, and a crash must never read as "safe to destroy".
    console.error('retire failed:', err.stack || err.message);
    process.exit(1);
  });
