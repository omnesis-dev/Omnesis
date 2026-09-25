// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Builds the citation-edge-cases demo fixture. Exercises the citation
 * sidebar flows that the vendor-evaluation scenario doesn't cover:
 *
 *   1. Two `annotate` calls on the same document with distinct quotes —
 *      panel must accumulate entries under one card.
 *   2. A note-only `annotate` on the same document — promoted to a
 *      doc-level note (card header), NOT a third quote entry.
 *   3. A note-only `annotate` on a non-text item (calendar event) — the
 *      card has only a doc-level note, no quote entries.
 *
 * Annotate tool calls are silent (no inline rendering); the demo's surface
 * is the sidebar + the per-message count chip.
 *
 * Run after edits:
 *   node evals/fixtures/agent/build-demo-citation-edge-cases.mjs
 *
 * Routing triggers and placeholder declarations live in the sibling
 * `demos/citation-edge-cases.meta.json` file.
 */

import { writeFileSync } from "node:fs";

const $S = "$SESSION";
const $M = "$MSG";

const DOC = {
  notion: "$DOC_synth-notion-page-003",
  calendar: "$DOC_synth-gcal-003",
};

function evt(afterMs, type, payload) {
  return JSON.stringify({ afterMs, event: { type, payload } });
}

const events = [
  evt(400, "agent.message.start", { sessionId: $S, messageId: $M, role: "assistant" }),
  evt(140, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta: "Pulling the comparison page so I can ground this.",
  }),

  // ── First cite on the comparison doc ────────────────────────────────
  evt(900, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_cite_notion_1",
    tool: "annotate",
    args: {
      documentId: DOC.notion,
      quote: "Current leaning: Globex pending SOC2 attestation.",
    },
    intent: "Cite the comparison page",
  }),
  evt(220, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_cite_notion_1",
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

  // ── Second cite on the same doc with a different quote ───────────────
  evt(220, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_cite_notion_2",
    tool: "annotate",
    args: {
      documentId: DOC.notion,
      quote: "Comparison axes: throughput, SOC2, pricing, support.",
    },
    intent: "Cite a second fact from the same doc",
  }),
  evt(220, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_cite_notion_2",
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
      quote: "Comparison axes: throughput, SOC2, pricing, support.",
    },
  }),

  // ── Doc-level note on the same comparison doc ───────────────────────
  //     note-only → routes to docNote (card header), NOT a quote entry.
  evt(220, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_cite_notion_doc",
    tool: "annotate",
    args: {
      documentId: DOC.notion,
      note: "Canonical comparison page used to make the call",
    },
    intent: "Doc-level note on the comparison page",
  }),
  evt(220, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_cite_notion_doc",
    durationMs: 5,
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
      note: "Canonical comparison page used to make the call",
    },
  }),

  // ── Note-only cite on a non-text item ────────────────────────────────
  evt(220, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_cite_calendar",
    tool: "annotate",
    args: {
      documentId: DOC.calendar,
      note: "scheduled vendor sync",
    },
    intent: "Cite the calendar event with a note (no quote)",
  }),
  evt(220, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_cite_calendar",
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
      note: "scheduled vendor sync",
    },
  }),

  // ── Final wrap + end ──────────────────────────────────────────────────
  evt(220, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      "\n\nDone. Two facts traced to the comparison page, one to the calendar event for the sync.",
  }),
  evt(400, "agent.message.end", {
    sessionId: $S,
    messageId: $M,
    stopReason: "end_turn",
    usage: { inputTokens: 412, outputTokens: 156, cacheReadTokens: 380, cacheCreationTokens: 0 },
  }),
];

const out =
  "# Demo fixture — citation edge cases.\n" +
  "# Generated by build-demo-citation-edge-cases.mjs.\n" +
  events.join("\n") +
  "\n";
writeFileSync(new URL("../citation-edge-cases.jsonl", import.meta.url), out);
console.log(`wrote ${events.length} entries`);
