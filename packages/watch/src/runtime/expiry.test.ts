// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A watch whose question has ended.
 *
 * Some watches are bound to a dated thing — a dinner, a flight, a deadline —
 * and past that date there is no longer a question to ask. That is not the same
 * as being answered: `once_ever` retires a watch because it got what it was
 * waiting for, and expiry retires one because what it was waiting for stopped
 * mattering. A ledger that could not tell those apart would show a watch that
 * was overtaken as one that never fired.
 *
 * Expiry is about relevance, not absence. "She never declined and the dinner
 * happened" is a different question; a watch that wanted it would have to say
 * so. Expiry says only that the asking is over.
 */

import { describe, expect, it } from "vitest";

import { watchDslSchema } from "../dsl/schema.js";
import { AnalyticsDatabase } from "../universe/analytics.js";
import { analyticsDir, loadOntology } from "../universe/paths.js";
import { validateWatch } from "../validator/validate.js";
import { WatchEngine } from "./engine.js";
import { ScriptedJudge, ScriptedRecall } from "./providers.js";
import { WatchStateStore } from "./state.js";
import type { JournalEvent } from "../journal/event.js";
import type { WatchTrace } from "./trace.js";

const ontology = loadOntology();
const SELF = "0a1b2c3d-0000-4000-8000-000000000001";

function at(day: number): string {
  return new Date(Date.UTC(2026, 2, day, 9)).toISOString();
}

function email(seq: number, day: number): JournalEvent {
  return {
    seq,
    kind: "doc.event",
    occurredAt: at(day),
    observedAt: at(day),
    payload: {
      op: "created",
      docId: `d0c00000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
      sourceId: "gmail",
      providerId: "google",
      documentType: "email",
      title: `message ${seq}`,
      semanticTime: at(day),
      changedFields: [],
      contentChanged: false,
      metadata: { extra: { threadId: "t-1" } },
      people: [{ personId: SELF, role: "recipient", isSelf: true }],
    },
  };
}

/** Fires on every mail, so what the trace shows is only what expiry allowed. */
function watch(extra: Record<string, unknown>): unknown {
  return {
    watch: {
      name: "any-mail",
      firing_policy: "stays_active",
      ontology_fingerprint: ontology.fingerprint,
      ...extra,
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
      judge: new ScriptedJudge({ judgements: [] }),
      recall: new ScriptedRecall([]),
    }).run();
  } finally {
    analytics.close();
  }
}

/**
 * A pass as a live host drives one: real time supplied, and a store that
 * outlives the run so a boundary armed by one pass is still there for the next.
 */
async function runLive(
  raw: unknown,
  journal: JournalEvent[],
  store: WatchStateStore,
  timeReachedMs: number,
): Promise<WatchTrace> {
  const analytics = await AnalyticsDatabase.materialize(ontology, analyticsDir(), "projections");
  try {
    return await new WatchEngine({
      watch: watchDslSchema.parse(raw).watch,
      ontology,
      journal,
      analytics,
      store,
      timeReachedMs,
      judge: new ScriptedJudge({ judgements: [] }),
      recall: new ScriptedRecall([]),
    }).run();
  } finally {
    analytics.close();
  }
}

const JOURNAL = [email(1, 1), email(2, 2), email(3, 3), email(4, 4)];

describe("a watch with a horizon", () => {
  it("says nothing about anything past it", async () => {
    const trace = await run(watch({ expires_at: at(2) }), JOURNAL);
    expect(trace.firings, "the watch spoke after its question had ended").toHaveLength(2);
  });

  it("fires normally right up to it", async () => {
    const trace = await run(watch({ expires_at: at(4) }), JOURNAL);
    expect(trace.firings, "the horizon retired the watch early").toHaveLength(4);
  });

  it("is unbounded when it declares none", async () => {
    const trace = await run(watch({}), JOURNAL);
    expect(trace.firings).toHaveLength(4);
  });

  it("ends as expired, which is not how a satisfied watch ends", async () => {
    // The distinction the ledger is for. Both watches stop; only one of them
    // got what it was waiting for.
    const overtaken = await run(watch({ expires_at: at(2) }), JOURNAL);
    expect(overtaken.ended).toBe("expired");

    const satisfied = await run(watch({ firing_policy: "once_ever", expires_at: at(4) }), JOURNAL);
    expect(satisfied.ended, "a watch that fired and retired was called expired").toBe("fired");
    expect(satisfied.firings).toHaveLength(1);
  });

  it("does not end at all while it is still live", async () => {
    const trace = await run(watch({ expires_at: at(9) }), JOURNAL);
    expect(trace.ended, "a live watch was reported as ended").toBeUndefined();
  });

  it("honours a deadline that came due before the horizon", async () => {
    // A deadline that fell in the gap between two events is one the watch owed.
    // Retiring before the gap is swept would make whether it is honoured depend
    // on whether an unrelated event happened to land inside the gap, and would
    // record the watch as overtaken when it had an answer waiting.
    const due = {
      watch: {
        name: "one-off-inside-the-horizon",
        firing_policy: "stays_active",
        expires_at: at(10),
        ontology_fingerprint: ontology.fingerprint,
        nodes: [{ id: "tick", type: "source.time", one_off: at(5) }],
        sink: { input: "tick", output_map: {} },
      },
    };

    // The gap: nothing happens between day 1 and day 20, so the one-off comes
    // due unobserved and is swept on the arriving event — which is past the
    // horizon.
    const trace = await run(due, [email(1, 1), email(2, 20)]);
    expect(trace.firings, "a deadline owed before the horizon was dropped").toHaveLength(1);
  });

  it("retires on the clock when nothing arrives to carry it past the horizon", async () => {
    // The shape a recurring digest is in every night: a boundary armed by an
    // earlier pass, a horizon that goes by, and no journal event in between.
    // Nothing is arriving to be read the horizon off, so a watch that only ever
    // consults it on an arriving event fires every morning after it retired.
    const digest = {
      watch: {
        name: "daily-digest",
        firing_policy: "stays_active",
        expires_at: at(1),
        ontology_fingerprint: ontology.fingerprint,
        nodes: [{ id: "tick", type: "source.time", recurring: "0 7 * * *" }],
        sink: { input: "tick", output_map: {} },
      },
    };
    const store = new WatchStateStore();
    try {
      // An hour before the horizon: the watch is live and arms tomorrow's 07:00.
      await runLive(digest, [], store, Date.parse(at(1)) - 3_600_000);
      // A week later, with nothing at all on the journal.
      const after = await runLive(digest, [], store, Date.parse(at(9)));

      expect(after.firings, "the watch went on speaking past its horizon").toHaveLength(0);
      expect(after.ended, "the run did not record the watch as overtaken").toBe("expired");
      expect(
        store.isActive("daily-digest"),
        "a watch past its horizon was still reported active",
      ).toBe(false);
    } finally {
      store.close();
    }
  });

  it("drops a deadline that came due after the horizon", async () => {
    // The mirror of the owed-deadline case above. This one falls in the same
    // gap, but on the far side of the horizon — by the time it came due the
    // watch was not asking anything, so sweeping the gap must not fire it.
    const due = {
      watch: {
        name: "one-off-past-the-horizon",
        firing_policy: "stays_active",
        expires_at: at(10),
        ontology_fingerprint: ontology.fingerprint,
        nodes: [{ id: "tick", type: "source.time", one_off: at(15) }],
        sink: { input: "tick", output_map: {} },
      },
    };

    const trace = await run(due, [email(1, 1), email(2, 20)]);
    expect(trace.firings, "a deadline the watch no longer owed was fired").toHaveLength(0);
    expect(trace.ended).toBe("expired");
  });

  it("is not retired by a document dated in the future", async () => {
    // `occurredAt` is semantic time, and a backfill can carry one years out — a
    // save-the-date, a scheduled send, a wrong header. Read on that clock, one
    // such document ends the watch permanently and silently drops every real
    // event after it.
    // Narrowed before the spread: spreading the union and replacing `payload`
    // loses the tie between `kind` and the payload's shape.
    const base = email(2, 1);
    if (base.kind !== "doc.event") throw new Error("expected a document event");
    const forwardDated: JournalEvent = {
      ...base,
      occurredAt: at(120),
      payload: { ...base.payload, semanticTime: at(120) },
    };
    const trace = await run(watch({ expires_at: at(10) }), [
      email(1, 1),
      forwardDated,
      email(3, 3),
      email(4, 4),
    ]);
    expect(
      trace.firings.length,
      "one forward-dated document retired the watch and swallowed the rest",
    ).toBeGreaterThan(2);
  });

  it("stays retired once its horizon passes", async () => {
    // Not a gate that reopens: an event whose time falls before the horizon,
    // arriving after one that fell past it, does not revive the watch. The
    // journal is ordered by sequence and the watch stops at the first event
    // that is too late.
    const trace = await run(watch({ expires_at: at(2) }), [...JOURNAL, email(5, 1)]);
    expect(trace.firings).toHaveLength(2);
    expect(trace.ended).toBe("expired");
  });
});

describe("the lint for a watch bound to something dated", () => {
  /** A watch carrying a resolved referent: a frozen date with provenance. */
  function bound(extra: Record<string, unknown>): unknown {
    return {
      watch: {
        name: "dinner-declined",
        firing_policy: "once_ever",
        ontology_fingerprint: ontology.fingerprint,
        constants: {
          dinner_at: {
            type: "timestamp",
            value: "2026-03-14T19:00:00.000Z",
            provenance_doc: "d0c00000-0000-4000-8000-000000000abc",
            provenance_note: "the calendar entry the request pointed at",
          },
        },
        ...extra,
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

  const codes = (raw: unknown): string[] =>
    validateWatch(raw, ontology).diagnostics.map((d) => d.code);

  it("asks for a horizon when the watch has none", () => {
    expect(codes(bound({}))).toContain("LINT_DATED_REFERENT_WITHOUT_EXPIRY");
  });

  it("says nothing once one is declared", () => {
    expect(codes(bound({ expires_at: "2026-03-15T19:00:00.000Z" }))).not.toContain(
      "LINT_DATED_REFERENT_WITHOUT_EXPIRY",
    );
  });

  it("says nothing about a watch bound to nothing dated", () => {
    expect(codes(watch({}))).not.toContain("LINT_DATED_REFERENT_WITHOUT_EXPIRY");
  });

  it("is a warning, so a deliberately open-ended watch still validates", () => {
    // The horizon is a judgement. A watch bound to a passport's expiry may
    // reasonably outlive it, and a compiler that could not say so would be
    // forced either to lie or to fail.
    const result = validateWatch(bound({}), ontology);
    expect(result.valid, "the lint was raised as an error").toBe(true);
  });
});
