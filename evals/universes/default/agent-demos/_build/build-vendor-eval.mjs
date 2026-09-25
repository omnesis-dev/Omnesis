// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Builds the vendor-evaluation demo fixture. Anchored on the cross-source
 * thread the synth providers already publish — gmail / drive / notion /
 * calendar / whatsapp all reference the same "Globex vs Nimbus" vendor
 * comparison Jane Doe is leading.
 *
 * Run after edits:
 *   node evals/fixtures/agent/build-demo-fixture.mjs
 *
 * The gateway substitutes the `$DOC_<externalId>` and `$PERSON_<Name>`
 * placeholders below by reading the live `documents` + `people` tables
 * at session-create time. The list of placeholders to resolve — plus
 * the scenario's routing `triggers` — live in the sibling
 * `demos/vendor-eval.meta.json` file.
 */

import { writeFileSync } from "node:fs";

const $S = "$SESSION";
const $M = "$MSG";

// Stable per-externalId placeholders — match the synth fixtures' external IDs
// for the vendor-evaluation thread.
const DOC = {
  gmail: "$DOC_synth-gmail-003",
  drive: "$DOC_synth-gdrive-002",
  notion: "$DOC_synth-notion-page-003",
  calendar: "$DOC_synth-gcal-003",
  whatsapp: "$DOC_synth-whatsapp-001",
};
const PERSON_JANE = "$PERSON_Jane_Doe";

function evt(afterMs, type, payload) {
  return JSON.stringify({ afterMs, event: { type, payload } });
}

const events = [
  evt(400, "agent.message.start", { sessionId: $S, messageId: $M, role: "assistant" }),
  evt(140, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta: "Let me pull together where you are on the vendor evaluation.",
  }),

  // ── Turn 1: broad search ───────────────────────────────────────────────
  evt(900, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_1",
    tool: "search_documents",
    args: { query: "vendor evaluation Globex Nimbus", limit: 6 },
    intent: "Surface every cross-source mention of the vendor comparison",
  }),
  evt(1800, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_1",
    durationMs: 612,
    result: {
      kind: "search.results",
      query: "vendor evaluation Globex Nimbus",
      durationMs: 612,
      candidates: 14,
      results: [
        {
          documentId: DOC.notion,
          sourceType: "notion-pages",
          sourceId: "notion-pages:self",
          documentType: "note",
          title: "Vendor evaluation — comparison matrix",
          snippet:
            "Owner: Jane Doe — Vendors: Globex, Nimbus. Axes: throughput, SOC2, pricing, support. Current leaning: Globex pending SOC2 attestation.",
          ts: 1757237400000,
        },
        {
          documentId: DOC.drive,
          sourceType: "google-drive",
          sourceId: "google-drive:self",
          documentType: "file",
          title: "Vendor evaluation matrix.gsheet",
          snippet:
            "Globex — High throughput, SOC2 pending Nov, $$ pricing, Tier-2 support. Nimbus — Medium throughput, SOC2 Yes, $$$ pricing, Tier-1 support.",
          ts: 1757237400000,
        },
        {
          documentId: DOC.gmail,
          sourceType: "gmail",
          sourceId: "gmail:self",
          documentType: "email",
          title: "Re: Vendor evaluation — first cut",
          snippet:
            "Quick note from my personal email — let me know if you'd prefer continuing on Acme mail. (Easier to track from one place.)",
          ts: 1756812600000,
        },
        {
          documentId: DOC.calendar,
          sourceType: "google-calendar",
          sourceId: "google-calendar:self",
          documentType: "event",
          title: "Vendor evaluation sync",
          snippet: "Globex vs Nimbus comparison review. Mercury room.",
          ts: 1757584800000,
        },
        {
          documentId: DOC.whatsapp,
          sourceType: "whatsapp-messages",
          sourceId: "whatsapp-messages:self",
          documentType: "conversation",
          title: "Jane Doe — 2025-09-04",
          snippet:
            'Jane: Got a sec for the vendor compare? · Jane: "SOC2 thing is going to bite us."',
          ts: 1757001240000,
        },
      ],
    },
  }),

  evt(140, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      "\n\nFive items across Notion, Drive, Gmail, Calendar, and WhatsApp. Jane is driving it. Let me read her notion page in full to see the current state.",
  }),

  // ── Turn 2: fetch the notion comparison ───────────────────────────────
  evt(900, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_2",
    tool: "fetch_document",
    args: { documentId: DOC.notion },
    intent: "Read Jane's comparison matrix",
  }),
  evt(1400, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_2",
    durationMs: 318,
    result: {
      kind: "document",
      ref: {
        documentId: DOC.notion,
        sourceType: "notion-pages",
        sourceId: "notion-pages:self",
        documentType: "note",
        title: "Vendor evaluation — comparison matrix",
        ts: 1757237400000,
      },
      document: {
        id: DOC.notion,
        title: "Vendor evaluation — comparison matrix",
        content:
          "# Vendor evaluation — comparison matrix\n\nOwner: Jane Doe\n\nVendors: Globex, Nimbus. Comparison axes: throughput, SOC2, pricing, support.\n\nCurrent leaning: Globex pending SOC2 attestation.",
      },
    },
  }),

  evt(140, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta: "\n\nGlobex is the front-runner, blocked on SOC2.",
  }),

  // ── Turn 2b: cite the comparison page that established the leaning ────
  evt(700, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_notion",
    tool: "annotate",
    args: {
      documentId: DOC.notion,
      quote: "Current leaning: Globex pending SOC2 attestation.",
    },
    intent: "Annotate the Notion comparison for the Globex-pending-SOC2 fact",
  }),
  evt(220, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_notion",
    durationMs: 6,
    result: {
      kind: "annotate.recorded",
      documentId: DOC.notion,
      ref: {
        documentId: DOC.notion,
        sourceType: "notion-pages",
        sourceId: "notion-pages:self",
        documentType: "note",
        title: "Vendor evaluation — comparison matrix",
        ts: 1757237400000,
      },
      quote: "Current leaning: Globex pending SOC2 attestation.",
    },
  }),

  // ── Turn 2c: cite the Drive matrix with the row-level quote ───────────
  evt(220, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_drive",
    tool: "annotate",
    args: {
      documentId: DOC.drive,
      quote: "Globex — High throughput, SOC2 pending Nov, $$ pricing, Tier-2 support.",
    },
    intent: "Annotate the Drive matrix row backing the Globex SOC2 ETA",
  }),
  evt(220, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_drive",
    durationMs: 7,
    result: {
      kind: "annotate.recorded",
      documentId: DOC.drive,
      ref: {
        documentId: DOC.drive,
        sourceType: "google-drive",
        sourceId: "google-drive:self",
        documentType: "file",
        title: "Vendor evaluation matrix.gsheet",
        ts: 1757237400000,
      },
      quote: "Globex — High throughput, SOC2 pending Nov, $$ pricing, Tier-2 support.",
    },
  }),

  evt(140, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta: " Let me trace how the spreadsheet got into your corpus.",
  }),

  // ── Turn 3: build the event trail around the Drive matrix ─────────────
  //    The Drive sheet anchors the comparison; the trail surfaces every
  //    related document the link graph reaches — Jane's Notion page, the
  //    Gmail thread, the Calendar review, and the WhatsApp follow-up.
  //    Renderers project this into the unified Timeline in the side
  //    panel; `annotate` calls below pin commentary onto specific docs.
  evt(900, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_3_trail",
    tool: "trace_connections",
    args: { seedIds: [DOC.drive], depth: 4 },
    intent: "Trace every doc related to the vendor comparison around the Drive matrix",
  }),
  evt(1300, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_3_trail",
    durationMs: 277,
    result: {
      kind: "event_trail.built",
      seeds: [DOC.drive],
      events: [
        {
          eventId: "evt-gmail-first-cut",
          at: "2025-08-31T08:50:00Z",
          kind: "document",
          doc: {
            documentId: DOC.gmail,
            title: "Re: Vendor evaluation — first cut",
            sourceId: "gmail:self",
            documentType: "email",
          },
          attachments: [],
          people: [
            { personId: "p-jane", name: "Jane Doe", role: "sender", isSelf: false },
            { personId: "p-self", name: "You", role: "recipient", isSelf: true },
          ],
          related: [],
        },
        {
          eventId: "evt-wa-jane",
          at: "2025-09-04T16:34:00Z",
          kind: "document",
          doc: {
            documentId: DOC.whatsapp,
            title: "Jane Doe — 2025-09-04",
            sourceId: "whatsapp-messages:self",
            documentType: "conversation",
          },
          attachments: [],
          people: [
            { personId: "p-jane", name: "Jane Doe", role: "participant", isSelf: false },
            { personId: "p-self", name: "You", role: "participant", isSelf: true },
          ],
          related: [],
        },
        {
          eventId: "evt-notion-matrix",
          at: "2025-09-07T09:30:00Z",
          kind: "document",
          doc: {
            documentId: DOC.notion,
            title: "Vendor evaluation — comparison matrix",
            sourceId: "notion-pages:self",
            documentType: "note",
          },
          attachments: [],
          people: [{ personId: "p-jane", name: "Jane Doe", role: "owner", isSelf: false }],
          related: [],
        },
        {
          eventId: "evt-drive-sheet",
          at: "2025-09-07T09:30:00Z",
          kind: "seed",
          doc: {
            documentId: DOC.drive,
            title: "Vendor evaluation matrix.gsheet",
            sourceId: "google-drive:self",
            documentType: "file",
            mimeType: "application/vnd.google-apps.spreadsheet",
          },
          attachments: [],
          people: [],
          related: [],
        },
        {
          eventId: "evt-cal-sync",
          at: "2025-09-11T10:00:00Z",
          kind: "document",
          doc: {
            documentId: DOC.calendar,
            title: "Vendor evaluation sync",
            sourceId: "google-calendar:self",
            documentType: "event",
          },
          attachments: [],
          people: [
            { personId: "p-jane", name: "Jane Doe", role: "attendee", isSelf: false },
            { personId: "p-self", name: "You", role: "attendee", isSelf: true },
          ],
          related: [],
        },
      ],
      truncated: false,
      stats: { visited: 5, elapsedMs: 277, maxDepthReached: 3 },
    },
  }),

  evt(140, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      "\n\nThe trail: Gmail first-cut → WhatsApp follow-up → Notion comparison + Drive sheet → Calendar review.",
  }),

  // ── Turn 3b: annotate the WhatsApp + Calendar docs on the trail ──
  //    Every annotation targets a documentId; the unified Timeline
  //    derives the chronological position from the doc's trail event.
  evt(420, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_whatsapp",
    tool: "annotate",
    args: {
      documentId: DOC.whatsapp,
      quote: "SOC2 thing is going to bite us.",
      note: "Jane flagged the SOC2 blocker on this thread",
    },
    intent: "Pin Jane's SOC2 warning onto the WhatsApp doc",
  }),
  evt(220, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_whatsapp",
    durationMs: 5,
    result: {
      kind: "annotate.recorded",
      documentId: DOC.whatsapp,
      ref: {
        documentId: DOC.whatsapp,
        sourceType: "whatsapp-messages",
        sourceId: "whatsapp-messages:self",
        documentType: "conversation",
        title: "Jane Doe — 2025-09-04",
        ts: 1757001240000,
      },
      quote: "SOC2 thing is going to bite us.",
      note: "Jane flagged the SOC2 blocker on this thread",
    },
  }),
  // Doc-level note (no quote) on the Calendar event — surfaces as a
  // single italic caption on that doc's Timeline row.
  evt(220, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_cal",
    tool: "annotate",
    args: {
      documentId: DOC.calendar,
      note: "The scheduled review where the SOC2 question needs to land",
    },
    intent: "Note the calendar event as the deadline for the SOC2 call",
  }),
  evt(200, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_cal",
    durationMs: 5,
    result: {
      kind: "annotate.recorded",
      documentId: DOC.calendar,
      ref: {
        documentId: DOC.calendar,
        sourceType: "google-calendar",
        sourceId: "google-calendar:self",
        documentType: "event",
        title: "Vendor evaluation sync",
        ts: 1757584800000,
      },
      note: "The scheduled review where the SOC2 question needs to land",
    },
  }),

  // ── Turn 4: look up Jane's interaction summary ────────────────────────
  evt(140, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      "\n\nWorth flagging: Jane writes from both her Acme and personal addresses — Omnesis merged those into one person, so her whole footprint on this decision stays in one place. Here's her interaction summary:",
  }),
  evt(900, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_4",
    tool: "lookup_people",
    args: { query: "Jane Doe" },
    intent: "Surface Jane's interaction summary",
  }),
  evt(900, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_4",
    durationMs: 178,
    result: {
      kind: "person.results",
      query: "Jane Doe",
      durationMs: 178,
      results: [
        {
          canonicalId: PERSON_JANE,
          displayName: "Jane Doe",
          aliases: ["jane.doe@acme.example", "jane.doe@example.org", "+15550101"],
          emailCount: 12,
          chatCount: 6,
          meetingCount: 4,
          lastInteraction: 1757001240000,
          interactionScore: 0.78,
        },
      ],
    },
  }),

  // ── Turn 5: SQL — documents per source for Jane ───────────────────────
  evt(140, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta: "\n\nAnd a quick breakdown of where Jane shows up across your corpus, by source:",
  }),
  evt(900, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_5",
    tool: "run_sql",
    args: {
      sql:
        "SELECT substr(d.source_id, 0, instr(d.source_id, ':')) AS source, COUNT(*) AS docs\n" +
        "FROM documents d\n" +
        "JOIN document_people dp ON dp.document_id = d.id\n" +
        "JOIN people p ON p.id = dp.person_id\n" +
        "WHERE p.canonical_name = 'Jane Doe'\n" +
        "GROUP BY 1\n" +
        "ORDER BY docs DESC",
    },
    intent: "Documents per source mentioning Jane",
  }),
  evt(1500, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_5",
    durationMs: 238,
    result: {
      kind: "sql.rows",
      sql:
        "SELECT substr(d.source_id, 0, instr(d.source_id, ':')) AS source, COUNT(*) AS docs\n" +
        "FROM documents d\n" +
        "JOIN document_people dp ON dp.document_id = d.id\n" +
        "JOIN people p ON p.id = dp.person_id\n" +
        "WHERE p.canonical_name = 'Jane Doe'\n" +
        "GROUP BY 1\n" +
        "ORDER BY docs DESC",
      columns: ["source", "docs"],
      // Rows below are illustrative — when the user clicks "Open in SQL"
      // and re-runs, real numbers from the seeded synth corpus appear.
      rows: [
        ["gmail", 4],
        ["whatsapp-messages", 2],
        ["notion-pages", 1],
        ["google-drive", 1],
        ["google-calendar", 1],
      ],
      rowCount: 5,
      durationMs: 238,
    },
  }),

  // ── Final summary + end ───────────────────────────────────────────────
  evt(140, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      "\n\nSummary:\n\n- Vendor decision owner: Jane Doe — Globex leading, blocked on SOC2 attestation (expected Nov).\n- Artifacts: Notion comparison page, Drive matrix, Gmail thread, Calendar review, WhatsApp follow-up.\n- Next action: Jane wants to nail down the SOC2 question before the next vendor sync. Worth pinging her with the latest from Globex.",
  }),
  evt(500, "agent.message.end", {
    sessionId: $S,
    messageId: $M,
    stopReason: "end_turn",
    usage: { inputTokens: 1248, outputTokens: 412, cacheReadTokens: 980, cacheCreationTokens: 0 },
  }),
];

const out =
  "# Demo fixture — vendor-evaluation scenario.\n" +
  "# Generated by build-demo-fixture.mjs — anchored on synth fixtures.\n" +
  events.join("\n") +
  "\n";
writeFileSync(new URL("../vendor-eval.jsonl", import.meta.url), out);
console.log(`wrote ${events.length} entries`);
