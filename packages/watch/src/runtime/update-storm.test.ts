// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * One episode, one firing.
 *
 * A document is indexed for reasons that have nothing to do with what it says:
 * a backfill, a re-embedding, a retry, a field the source touched without
 * changing the text. A nominating source that looked afresh at each of those
 * would speak every time — every individual decision locally correct, no error
 * raised anywhere, and only a person noticing the repetition able to tell that
 * the watch had stopped saying anything new.
 *
 * So the ratio is the measurement. Replay one entity's whole life — created,
 * indexed, re-indexed, updated without content, updated with content — and
 * count firings against episodes. One nomination per lifecycle the source
 * subscribes to, and a second only when the content actually moved.
 */

import { describe, expect, it } from "vitest";

import { watchDslSchema } from "../dsl/schema.js";
import { AnalyticsDatabase } from "../universe/analytics.js";
import { analyticsDir, loadOntology } from "../universe/paths.js";
import { validateWatch } from "../validator/validate.js";
import { WatchEngine } from "./engine.js";
import { ScriptedJudge, ScriptedRecall } from "./providers.js";
import type { JournalEvent } from "../journal/event.js";
import type { WatchTrace } from "./trace.js";

const ontology = loadOntology();
const DOC = "d0c00000-0000-4000-8000-00000000dead";
const SELF = "0a1b2c3d-0000-4000-8000-000000000001";

function at(day: number, hour = 9): string {
  return new Date(Date.UTC(2026, 2, day, hour)).toISOString();
}

/** The document arriving, or changing. */
function docEvent(
  seq: number,
  day: number,
  op: "created" | "updated",
  contentChanged: boolean,
  title = "Riverside Estate — quote for the spring works",
): JournalEvent {
  return {
    seq,
    kind: "doc.event",
    occurredAt: at(day),
    observedAt: at(day),
    payload: {
      op,
      docId: DOC,
      sourceId: "gmail",
      providerId: "google",
      documentType: "email",
      title,
      semanticTime: at(day),
      changedFields: contentChanged ? ["body"] : ["labels"],
      contentChanged,
      metadata: { extra: { threadId: "t-storm" } },
      people: [{ personId: SELF, role: "recipient", isSelf: true }],
    },
  };
}

/** The indexer getting round to it, for whatever reason. */
function indexed(seq: number, day: number, hour: number): JournalEvent {
  return {
    seq,
    kind: "doc.indexed",
    occurredAt: at(day, hour),
    observedAt: at(day, hour),
    payload: { docId: DOC, eventIndexedAt: at(day, hour) },
  };
}

/** A watch that fires on anything its recall arm nominates and its judge accepts. */
function watching(events: readonly ("created" | "updated")[]): unknown {
  return {
    watch: {
      name: "quote-arrived",
      firing_policy: "stays_active",
      ontology_fingerprint: ontology.fingerprint,
      nodes: [
        {
          id: "mail",
          type: "source.document_event",
          filter: { source: "gmail", event: events, documentType: "email" },
          recall: { semantic: { query: "a quote for building work", threshold: 0.3 } },
          judge: {
            proposition: "This is a quote for building work.",
            output_schema: { decision: "bool" },
          },
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
      // Every nomination is accepted, so what the trace counts is nominations.
      judge: new ScriptedJudge({ judgements: [], fallback: { fired: true, output: {} } }),
      recall: new ScriptedRecall([], 1),
    }).run();
  } finally {
    analytics.close();
  }
}

describe("one entity's whole life", () => {
  /** Created, indexed, and then indexed four more times for the indexer's own reasons. */
  const REINDEXED: JournalEvent[] = [
    docEvent(1, 1, "created", false),
    indexed(2, 1, 10),
    indexed(3, 1, 14),
    indexed(4, 2, 3),
    indexed(5, 3, 3),
    indexed(6, 4, 3),
  ];

  it("fires once for a document indexed five times", async () => {
    const trace = await run(watching(["created"]), REINDEXED);
    expect(
      trace.firings,
      "a re-indexed document was reported once per index rather than once",
    ).toHaveLength(1);
  });

  it("fires once when the document is updated without its content moving", async () => {
    // A label, a folder, a read flag. The document the user cares about did not
    // change, so there is nothing to say a second time.
    const trace = await run(watching(["created", "updated"]), [
      ...REINDEXED,
      docEvent(7, 5, "updated", false),
      indexed(8, 5, 10),
      docEvent(9, 6, "updated", false),
      indexed(10, 6, 10),
    ]);
    expect(trace.firings, "bookkeeping updates were reported as news").toHaveLength(1);
  });

  it("fires a second time when the content actually moves", async () => {
    const trace = await run(watching(["created", "updated"]), [
      ...REINDEXED,
      docEvent(7, 5, "updated", false),
      indexed(8, 5, 10),
      docEvent(9, 6, "updated", true, "Riverside Estate — revised quote, spring works"),
      indexed(10, 6, 10),
      indexed(11, 6, 16),
      indexed(12, 7, 3),
    ]);
    expect(
      trace.firings,
      "a real change was missed, or the re-indexes after it were counted",
    ).toHaveLength(2);
  });

  it("never fires again for a source that watches only creations", async () => {
    // The content moved, but this watch was never asked about updates. One
    // lifecycle, one nomination.
    const trace = await run(watching(["created"]), [
      ...REINDEXED,
      docEvent(7, 5, "updated", true, "Riverside Estate — revised quote, spring works"),
      indexed(8, 5, 10),
    ]);
    expect(trace.firings, "a creations-only source spoke about an update").toHaveLength(1);
  });

  it("still fires on the creation when a document is touched before its first index", async () => {
    // The index lands on a clock of its own, and a label, a folder or a
    // re-synced thread can move the document between arriving and becoming
    // searchable. Resolving the index event to the newest revision alone would
    // offer a creations-only source an update, which it refuses on `op` — and
    // nothing later would ever bring the creation back, because everything
    // later is an update too.
    const trace = await run(watching(["created"]), [
      docEvent(1, 1, "created", false),
      docEvent(2, 1, "updated", false),
      indexed(3, 1, 10),
    ]);
    expect(
      trace.firings,
      "a creation was skipped because the document was touched before it was indexed",
    ).toHaveLength(1);
  });

  it("does not fire twice when the creation was recovered from below the index", async () => {
    // The other half: having reached back for the creation, the same node must
    // not reach back for it again on the next index of the same document.
    const trace = await run(watching(["created"]), [
      docEvent(1, 1, "created", false),
      docEvent(2, 1, "updated", false),
      indexed(3, 1, 10),
      docEvent(4, 2, "updated", true, "Riverside Estate — revised quote, spring works"),
      indexed(5, 2, 10),
      indexed(6, 3, 10),
    ]);
    expect(trace.firings, "the recovered creation was nominated more than once").toHaveLength(1);
  });

  it("gives each source its own first look at the same document", async () => {
    // Nomination belongs to the pair, not to the document. Two recall sources
    // over one document are two questions, and answering one does not answer
    // the other — a key that dropped the node would silence the second source
    // entirely.
    const twoSources = {
      watch: {
        name: "two-questions-one-document",
        firing_policy: "stays_active",
        ontology_fingerprint: ontology.fingerprint,
        nodes: [
          {
            id: "quotes",
            type: "source.document_event",
            filter: { source: "gmail", event: ["created"], documentType: "email" },
            recall: { semantic: { query: "a quote for building work", threshold: 0.3 } },
            judge: {
              proposition: "This is a quote for building work.",
              output_schema: { decision: "bool" },
            },
            output_map: { doc_id: "$e.docId" },
          },
          {
            id: "invoices",
            type: "source.document_event",
            filter: { source: "gmail", event: ["created"], documentType: "email" },
            recall: { semantic: { query: "an invoice", threshold: 0.3 } },
            judge: {
              proposition: "This is an invoice.",
              output_schema: { decision: "bool" },
            },
            output_map: { doc_id: "$e.docId" },
          },
          {
            id: "either",
            type: "stateless.or",
            inputs: { quotes: { role: "arm" }, invoices: { role: "arm" } },
            output_map: {},
          },
        ],
        sink: { input: "either", output_map: {} },
      },
    };

    const trace = await run(twoSources, [docEvent(1, 1, "created", false), indexed(2, 1, 10)]);
    const nominated = new Set(
      trace.records.filter((r) => r.transition === "fired").map((r) => r.nodeId),
    );
    expect(nominated, "one source's look was counted as the other's").toContain("quotes");
    expect(nominated).toContain("invoices");
  });

  it("gives each document its own first look from the same source", async () => {
    // The other half of the key. Two documents through one node are two
    // lifecycles; a key that dropped the document would nominate the first and
    // ignore every one after it.
    const second = "d0c00000-0000-4000-8000-00000000beef";
    // Narrowed before the spread: spreading the union and replacing `payload`
    // loses the tie between `kind` and the payload's shape.
    const other = (seq: number, day: number): JournalEvent => {
      const base = docEvent(seq, day, "created", false, "A different quote entirely");
      if (base.kind !== "doc.event") throw new Error("expected a document event");
      return { ...base, payload: { ...base.payload, docId: second } };
    };
    const indexedOther: JournalEvent = {
      seq: 4,
      kind: "doc.indexed",
      occurredAt: at(2, 10),
      observedAt: at(2, 10),
      payload: { docId: second, eventIndexedAt: at(2, 10) },
    };
    const trace = await run(watching(["created"]), [
      docEvent(1, 1, "created", false),
      indexed(2, 1, 10),
      other(3, 2),
      indexedOther,
    ]);
    expect(trace.firings, "the second document never got a first look").toHaveLength(2);
  });

  it("counts one firing per episode, which is the measurement", async () => {
    // The ratio, stated as a ratio. Two episodes the watch was told about —
    // the arrival and the revision — against ten indexes and three updates.
    const journal = [
      ...REINDEXED,
      docEvent(7, 5, "updated", false),
      indexed(8, 5, 10),
      docEvent(9, 6, "updated", true, "Riverside Estate — revised quote, spring works"),
      indexed(10, 6, 10),
      indexed(11, 6, 16),
      docEvent(12, 7, "updated", false),
      indexed(13, 7, 10),
    ];
    const trace = await run(watching(["created", "updated"]), journal);
    const episodes = 2;
    const indexes = journal.filter((e) => e.kind === "doc.indexed").length;

    expect(indexes, "the storm is not a storm").toBeGreaterThan(episodes * 3);
    expect(trace.firings.length / episodes, "more than one firing per episode").toBe(1);
  });
});
