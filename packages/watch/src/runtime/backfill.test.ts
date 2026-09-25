// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Arrival is not occurrence.
 *
 * Connect a bank account and four years of transactions land in a minute. Every
 * one of them is a real payment that really happened, and none of them is news:
 * the row is identical in shape to a live one, carries the same semantic time
 * it always had, and arrives on the same feed. Nothing in the row itself can
 * tell the two apart — only the journal knows which phase produced it.
 *
 * So the trip-wire ignores replayed rows by default, and the aggregate does
 * not: a running monthly total that skipped the history would be wrong, while
 * an arrival watch that honoured it would wake once per historical payment.
 * Both readings are legitimate and they need opposite behaviour from the same
 * event, which is why the policy is per node rather than per journal.
 */

import { describe, expect, it } from "vitest";

import { watchDslSchema } from "../dsl/schema.js";
import { AnalyticsDatabase } from "../universe/analytics.js";
import { analyticsDir, loadOntology } from "../universe/paths.js";
import { validateWatch } from "../validator/validate.js";
import { WatchEngine } from "./engine.js";
import { CountingJudge, ScriptedRecall } from "./providers.js";
import type { JournalEvent } from "../journal/event.js";
import type { WatchTrace } from "./trace.js";

const ontology = loadOntology();

function at(day: number): string {
  return new Date(Date.UTC(2026, 2, day, 9)).toISOString();
}

/** A payment landing on the journal, live or replayed. */
function payment(seq: number, amount: number, backfill?: boolean): JournalEvent {
  return {
    seq,
    kind: "analytics.row",
    occurredAt: at(seq),
    observedAt: at(seq),
    payload: {
      op: "inserted",
      table: "plaid_transactions",
      sourceId: "plaid",
      pk: { id: `t-${seq}` },
      row: {
        id: `t-${seq}`,
        account_id: "acct-1",
        date: at(seq).slice(0, 10),
        amount,
        currency: "GBP",
        merchant_name: "Stellar Sound",
        category: "entertainment",
        pending: false,
      },
      ...(backfill === undefined ? {} : { backfill }),
    },
  };
}

/** A trip-wire on large payments, reading replayed rows however it was told to. */
function watching(backfill?: "ignore" | "include"): unknown {
  return {
    watch: {
      name: "large-payment",
      firing_policy: "stays_active",
      ontology_fingerprint: ontology.fingerprint,
      nodes: [
        {
          id: "payment",
          type: "source.analytics_row",
          table: "plaid_transactions",
          op: ["inserted"],
          predicate: "amount > 100",
          ...(backfill === undefined ? {} : { backfill }),
          output_map: { amount: "$e.row.amount" },
        },
      ],
      sink: { input: "payment", output_map: { amount: "$n.payment.amount" } },
    },
  };
}

async function run(raw: unknown, journal: JournalEvent[]): Promise<WatchTrace> {
  const result = validateWatch(raw, ontology);
  expect(
    result.valid,
    `fixture must validate: ${result.diagnostics.map((d) => d.code).join(", ")}`,
  ).toBe(true);

  const analytics = await AnalyticsDatabase.materialize(ontology, analyticsDir(), "projections");
  try {
    return await new WatchEngine({
      watch: watchDslSchema.parse(raw).watch,
      ontology,
      journal,
      analytics,
      judge: new CountingJudge(),
      recall: new ScriptedRecall([], 0),
    }).run();
  } finally {
    analytics.close();
  }
}

/** Four replayed payments over the threshold, then one that happens today. */
const CONNECTED_TODAY: JournalEvent[] = [
  payment(1, 420, true),
  payment(2, 610, true),
  payment(3, 250, true),
  payment(4, 180, true),
  payment(5, 340),
];

describe("a source replaying its history", () => {
  it("wakes an arrival watch once — for the payment that actually happened", async () => {
    const trace = await run(watching(), CONNECTED_TODAY);
    expect(
      trace.firings.length,
      "connecting the account woke the watch once per historical payment",
    ).toBe(1);
    expect(trace.firings[0]?.payload.amount, "the firing was not the live payment").toBe(340);
  });

  it("wakes a watch that asked for the history on every row", async () => {
    const trace = await run(watching("include"), CONNECTED_TODAY);
    expect(trace.firings.length, "the opt-in did not reach the history").toBe(5);
  });

  it("treats a row with no flag as live, because absent means live", async () => {
    const trace = await run(watching(), [payment(1, 420)]);
    expect(trace.firings.length, "an unflagged row was read as history").toBe(1);
  });
});

describe("the store behind the trip-wire", () => {
  it("holds the replayed rows even while the trip-wire ignores them", async () => {
    // The two readings need opposite behaviour from the same event, and this is
    // the half that is easy to lose: a node downstream that sums the month is
    // wrong if the history never landed, however quiet the arm was.
    const analytics = await AnalyticsDatabase.materialize(ontology, analyticsDir(), "projections");
    try {
      const raw = watching();
      const trace = await new WatchEngine({
        watch: watchDslSchema.parse(raw).watch,
        ontology,
        journal: CONNECTED_TODAY,
        analytics,
        judge: new CountingJudge(),
        recall: new ScriptedRecall([], 0),
      }).run();
      expect(trace.firings.length).toBe(1);

      const total = await analytics.query(
        "SELECT COUNT(*) AS n FROM plaid_transactions WHERE id LIKE 't-%'",
        {},
      );
      expect(
        Number(total.rows[0]?.n),
        "replayed rows were dropped from the store, not just from the trip-wire",
      ).toBe(CONNECTED_TODAY.length);
    } finally {
      analytics.close();
    }
  });
});

describe("a document whose source declared no type", () => {
  /** A watch that fires on any email arriving, filtered by kind. */
  function typed(): unknown {
    return {
      watch: {
        name: "any-email",
        firing_policy: "stays_active",
        ontology_fingerprint: ontology.fingerprint,
        nodes: [
          {
            id: "mail",
            type: "source.document_event",
            filter: { source: "gmail", event: ["created"], documentType: "email" },
            output_map: { doc_id: "$e.docId" },
          },
        ],
        sink: { input: "mail", output_map: { doc_id: "$n.mail.doc_id" } },
      },
    };
  }

  function arriving(documentType: string | null): JournalEvent {
    return {
      seq: 1,
      kind: "doc.event",
      occurredAt: at(1),
      observedAt: at(1),
      payload: {
        op: "created",
        docId: "d0c00000-0000-4000-8000-00000000beef",
        sourceId: "gmail",
        providerId: "google",
        documentType,
        title: "Spring works",
        semanticTime: at(1),
        changedFields: [],
        contentChanged: true,
        metadata: {},
        people: [],
      },
    };
  }

  it("matches no type filter, rather than matching every one", async () => {
    // `documentType` is nullable because the metadata field is optional, and a
    // journal that invented a type for those documents would be lying. The
    // question is what a filter does when it meets one: the watch asked for a
    // kind of thing, and this is a document nobody said the kind of.
    const trace = await run(typed(), [arriving(null)]);
    expect(trace.firings, "an untyped document satisfied a type filter").toHaveLength(0);
  });

  it("still matches when the type is the one the filter names", async () => {
    const trace = await run(typed(), [arriving("email")]);
    expect(trace.firings, "a typed document stopped matching its own filter").toHaveLength(1);
  });
});
