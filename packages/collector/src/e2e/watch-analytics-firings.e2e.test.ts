// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Two things happening on one day are two things.
 *
 * A watch over an analytics table fires per arriving row, and an
 * `source.analytics_row` node keys every one of its firings on the singleton —
 * `fireSource` propagates `key: {}`. So of the four components the firings
 * table is unique on, `(watch, seq, node, key_hash)`, only the **sequence**
 * ever distinguishes one firing of such a watch from another.
 *
 * That makes the journal's per-row sequencing load-bearing in a way nothing
 * states out loud. Two large transactions posted on the same day are one event
 * each and therefore two sequences, and both are spoken about. Batch them into
 * one journal event — a plausible-looking optimisation, since the ingest signal
 * already re-fires for every row of every page — and the second firing collides
 * with the first on that unique constraint and is dropped. Not delayed, not
 * logged as lost: the second large payment of a busy day simply never happened.
 *
 * The bank tables that make this concrete carry a DATE, not a timestamp, so
 * both rows also share a semantic time. This asserts the two are still told
 * apart, and that each firing carries its own row rather than the pair being
 * merged into one.
 */

import "./synth-env.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";

interface WatchSummary {
  id: string;
  name: string;
  status: string;
  firings: number;
}

interface Firing {
  seq: number;
  firedAt: string;
  payload: Record<string, unknown>;
}

/** The synthetic Plaid item whose sync populates `plaid_transactions`. */
const SOURCE_ID = "plaid:plaid-item-johnsmith";
/** One day, so every row under test shares a semantic time. */
const THE_DAY = "2026-05-15";

let harness: SyntheticE2EHarness;

beforeEach(async () => {
  harness = new SyntheticE2EHarness({ gatewayMode: "experimental", universe: "e2e-minimal" });
  await harness.start();
  // Sync once so the table and its catalog entry exist: a node's predicate is
  // type-cast against the declared columns, and a table the ontology cannot
  // describe pauses the watch instead of evaluating it.
  await harness.triggerSyncAndWait(SOURCE_ID, 60_000);
}, 240_000);

afterEach(async () => {
  await harness.destroy();
}, 15_000);

/**
 * A watch on large outgoing transactions, procedural on purpose.
 *
 * No recall arm and no judge, so what is measured is the runtime's bookkeeping
 * rather than a model's mood. The predicate is a strict inequality on a signed
 * amount, which is the shape a real "tell me about anything over £100" watch
 * compiles to.
 */
function largePayments(
  fingerprint: string,
  name: string,
  op: Array<"inserted" | "updated">,
): unknown {
  return {
    watch: {
      name,
      firing_policy: "stays_active",
      ontology_fingerprint: fingerprint,
      nodes: [
        {
          id: "payment",
          type: "source.analytics_row",
          table: "plaid_transactions",
          op,
          predicate: "amount < -100",
          output_map: {
            amount: "$e.row.amount",
            date: "$e.row.date",
            transaction_id: "$e.row.transaction_id",
          },
        },
      ],
      sink: {
        input: "payment",
        output_map: {
          amount: "$n.payment.amount",
          date: "$n.payment.date",
          transaction_id: "$n.payment.transaction_id",
        },
      },
    },
  };
}

async function fingerprint(): Promise<string> {
  const { fingerprint } = await harness.gatewayJson<{ fingerprint: string }>(
    "/admin/watch/ontology",
  );
  expect(fingerprint, "the install declared no ontology").toBeTruthy();
  return fingerprint;
}

/**
 * Install the watch at the current head, so only rows pushed afterwards reach
 * it and the corpus the universe already synced cannot contribute firings.
 */
async function addWatch(
  name = "large-payments",
  op: Array<"inserted" | "updated"> = ["inserted"],
): Promise<WatchSummary> {
  const { watch } = await harness.gatewayJson<{ watch: WatchSummary }>("/admin/watch/watches", {
    method: "POST",
    body: JSON.stringify({ dsl: largePayments(await fingerprint(), name, op) }),
  });
  return watch;
}

/** Push transactions as the Plaid source would, one call, several records. */
async function pushTransactions(records: Array<Record<string, unknown>>): Promise<void> {
  const { wipeEpoch } = await harness.gatewayJson<{ wipeEpoch: number }>(
    `/sync-state/${encodeURIComponent(SOURCE_ID)}`,
  );
  await harness.gatewayJson("/analytics/ingest", {
    method: "POST",
    body: JSON.stringify({
      tableName: "plaid_transactions",
      sourceId: SOURCE_ID,
      records,
      writeEpoch: wipeEpoch,
    }),
  });
}

function transaction(
  transactionId: string,
  amount: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    transaction_id: transactionId,
    item_id: "plaid-item-johnsmith",
    account_id: "plaid-account-checking",
    date: THE_DAY,
    amount,
    currency: "USD",
    name: `Invented payment ${transactionId}`,
    pending: false,
    ...overrides,
  };
}

async function firingsOf(id: string): Promise<Firing[]> {
  const { firings } = await harness.gatewayJson<{ firings: Firing[] }>(
    `/admin/watch/watches/${id}/firings`,
  );
  return firings;
}

/**
 * Wait until the watch has said as much as it is going to, then keep watching.
 *
 * The settle is the discriminating half. Returning the moment the count is
 * reached would accept a runtime that goes on to repeat itself, and evaluation
 * ticks are seconds apart — a duplicate would land just after a bare wait
 * returned.
 */
async function settledFirings(id: string, expected: number): Promise<Firing[]> {
  const deadline = Date.now() + 90_000;
  let seen: Firing[] = [];
  while (Date.now() < deadline) {
    seen = await firingsOf(id);
    if (seen.length >= expected) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  expect(seen.length, `the watch said ${seen.length} things, expected ${expected}`).toBe(expected);
  await new Promise((resolve) => setTimeout(resolve, 8_000));
  const after = await firingsOf(id);
  expect(after.length, "the watch went on speaking after it should have settled").toBe(expected);
  return after;
}

describe("a watch over an analytics table, on rows that share a day", () => {
  test("tells two same-day payments apart, and carries each one's own row", async () => {
    const watch = await addWatch();
    await pushTransactions([
      transaction("invented-txn-morning", "-257.00"),
      transaction("invented-txn-evening", "-3500.00"),
    ]);

    const firings = await settledFirings(watch.id, 2);

    // The sequences are what tell them apart: the key hash is the singleton for
    // every firing of this node, so two firings sharing a sequence would be one
    // row in the firings table and the second payment would be gone.
    expect(new Set(firings.map((firing) => firing.seq)).size).toBe(2);
    // Both are placed at the same instant, because the column is a DATE. The
    // firing's identity does not come from its time, and this is the case that
    // proves it.
    expect(new Set(firings.map((firing) => firing.firedAt)).size).toBe(1);
    // Each firing carries the payment it was about, so the second is
    // individually recoverable rather than merged into the first.
    expect(firings.map((firing) => String(firing.payload.transaction_id)).sort()).toEqual([
      "invented-txn-evening",
      "invented-txn-morning",
    ]);
    expect(firings.map((firing) => String(firing.payload.amount)).sort()).toEqual([
      "-257.00",
      "-3500.00",
    ]);
  }, 180_000);

  test("says nothing twice about a row the source redelivers unchanged", async () => {
    // The ingest signal re-fires for every row of every page, so a page read
    // again is the ordinary case rather than the exception. A watch that spoke
    // on each redelivery would be unusable on any paging source.
    const watch = await addWatch();
    await pushTransactions([transaction("invented-txn-morning", "-257.00")]);
    const first = await settledFirings(watch.id, 1);

    await pushTransactions([transaction("invented-txn-morning", "-257.00")]);
    const second = await settledFirings(watch.id, 1);
    expect(second.map((firing) => firing.seq)).toEqual(first.map((firing) => firing.seq));
  }, 180_000);

  test("a change to a row is news only to a watch that asked for changes", async () => {
    // Redelivery is deduplicated on the row's contents rather than on its key,
    // so a pending payment that posts at a different amount is a genuine
    // second event rather than a repeat. Which watches hear about it is the
    // node's own declaration: one listening for arrivals alone stays quiet,
    // and that distinction is the whole reason `op` is a list.
    const arrivalsOnly = await addWatch("large-payments", ["inserted"]);
    const arrivalsAndChanges = await addWatch("large-payments-revised", ["inserted", "updated"]);
    await pushTransactions([transaction("invented-txn-morning", "-257.00")]);
    await settledFirings(arrivalsOnly.id, 1);
    await settledFirings(arrivalsAndChanges.id, 1);

    await pushTransactions([transaction("invented-txn-morning", "-262.50")]);

    const revised = await settledFirings(arrivalsAndChanges.id, 2);
    expect(revised.map((firing) => String(firing.payload.amount)).sort()).toEqual([
      "-257.00",
      "-262.50",
    ]);
    // Still one: the amount moved, but nothing arrived.
    const unchanged = await settledFirings(arrivalsOnly.id, 1);
    expect(unchanged.map((firing) => String(firing.payload.amount))).toEqual(["-257.00"]);
  }, 180_000);
});
