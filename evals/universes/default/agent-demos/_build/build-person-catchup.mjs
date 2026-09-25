// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Builds the person-catchup demo fixture — the people-graph showcase: on
 * the eve of a 1:1, the agent assembles everything still open with one
 * person by pulling across the CHANNELS that person lives in — Granola
 * meeting notes, Gmail (with an attached assessment report), WhatsApp —
 * and lands a crisp "here's what's on you" brief.
 *
 * Scenario (today = Mon 8 Jun 2026): the user has a 1:1 with Jane next
 * week and wants to walk in prepared. The three-step plan:
 *
 *   1. Pull the recent meetings with Jane.
 *   2. Scan the open threads across email and chat.
 *   3. Pin down what's actually still on the user — and surface the slot.
 *
 * Grounding note: the Q4 vendor thread genuinely dates to last October,
 * and the demo is honest about that — it's an item that got re-raised in
 * the May 1:1 and never closed, not something pretended to be fresh. Every
 * pinned quote appears in the cited fixture (the 1:1 transcript, the Gmail
 * body).
 *
 * Run after edits:
 *   node evals/universes/default/agent-demos/_build/build-person-catchup.mjs
 *
 * Routing triggers and placeholder declarations live in the sibling
 * `person-catchup.meta.json`.
 */

import { writeFileSync } from "node:fs";

const $S = "$SESSION";
const $M = "$MSG";

const DOC = {
  oneOnOne: "$DOC_not_synthMeet000002",
  q3: "$DOC_not_synthMeet000001",
  waJane: "$DOC_synth-whatsapp-015",
  gmailAssess: "$DOC_synth-gmail-023",
  calNext: "$DOC_synth-gcal-jane-next",
};

// Real per-source account suffixes (default universe) so citations hit the
// exact-id icon key as well as the type fallback.
const SRC = {
  granola: "granola-meetings:john.smith@example.com",
  gmail: "gmail:john.smith@example.com",
  wa: "whatsapp-messages:+15550100",
  cal: "google-calendar:john.smith@example.com",
};

const ts = (iso) => Date.parse(iso);

const PACE = 1.5;

function evt(afterMs, type, payload) {
  return JSON.stringify({ afterMs: Math.round(afterMs * PACE), event: { type, payload } });
}

const events = [
  evt(400, "agent.message.start", { sessionId: $S, messageId: $M, role: "assistant" }),
  evt(140, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      "On it — I'll pull your recent meetings with Jane, sweep the open threads across email and chat, then boil it down to what's actually still on you.",
  }),

  // ── Plan ─────────────────────────────────────────────────────────────
  evt(300, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_setup",
    tool: "plan",
    args: {
      add: [
        "Pull your recent meetings with Jane",
        "Scan open threads — email and chat",
        "Pin down what's still on you",
      ],
    },
    intent: "Lay out the three steps",
  }),
  evt(120, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_setup",
    durationMs: 3,
    result: {
      kind: "plan.updated",
      items: [
        { id: "p1", label: "Pull your recent meetings with Jane", status: "in_progress" },
        { id: "p2", label: "Scan open threads — email and chat", status: "pending" },
        { id: "p3", label: "Pin down what's still on you", status: "pending" },
      ],
    },
  }),

  // ── Step 1: the meetings ─────────────────────────────────────────────
  evt(700, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_search_jane",
    tool: "search_documents",
    args: { query: 'with:"Jane Doe"', limit: 8 },
    intent: "Everything recent involving Jane, across sources",
  }),
  evt(1400, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_search_jane",
    durationMs: 248,
    result: {
      kind: "search.results",
      query: 'with:"Jane Doe"',
      durationMs: 248,
      candidates: 7,
      results: [
        {
          documentId: DOC.oneOnOne,
          sourceType: "granola-meetings",
          sourceId: SRC.granola,
          documentType: "meeting",
          title: "1:1 with Jane",
          snippet:
            "Billing migration on track · re-raised the parked Q4 vendor call · Jane asked you to review her conference-talk abstract.",
          ts: ts("2026-05-11T17:30:00Z"),
        },
        {
          documentId: DOC.q3,
          sourceType: "granola-meetings",
          sourceId: SRC.granola,
          documentType: "meeting",
          title: "Acme Q3 Planning",
          snippet:
            "Jane owns the billing migration; Alex to scope the search rewrite; ship date end of August.",
          ts: ts("2026-05-04T15:00:00Z"),
        },
        {
          documentId: DOC.gmailAssess,
          sourceType: "gmail",
          sourceId: SRC.gmail,
          documentType: "email",
          title: "Q4 Vendor Assessment — final",
          snippet: "Jane Doe · report attached · Bluestone top pick subject to a SOC2 gap review.",
          ts: ts("2025-10-15T15:00:00Z"),
        },
        {
          documentId: DOC.waJane,
          sourceType: "whatsapp-messages",
          sourceId: SRC.wa,
          documentType: "conversation",
          title: "Jane Doe — 2025-10-15",
          snippet:
            'Jane: "their API is solid but the SOC2 timeline is the risk. It\'s all in the report."',
          ts: ts("2025-10-15T14:07:00Z"),
        },
      ],
    },
  }),
  evt(650, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_fetch_121",
    tool: "fetch_document",
    args: { documentId: DOC.oneOnOne },
    intent: "Read the last 1:1 for open threads",
  }),
  evt(1000, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_fetch_121",
    durationMs: 209,
    result: {
      kind: "document",
      ref: {
        documentId: DOC.oneOnOne,
        sourceType: "granola-meetings",
        sourceId: SRC.granola,
        documentType: "meeting",
        title: "1:1 with Jane",
        ts: ts("2026-05-11T17:30:00Z"),
      },
      document: {
        id: DOC.oneOnOne,
        title: "1:1 with Jane",
        content:
          "Billing migration: on track — Jane needs you to confirm the cutover date so she can schedule it.\nVendor assessment: still with you. She sent it back in October; Bluestone's her pick but the SOC2 gap is the risk. Needs your call to kick off procurement.\nPersonal: she asked you to review her conference-talk abstract before the CFP closes.",
      },
    },
  }),
  evt(380, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_cutover",
    tool: "annotate",
    args: {
      documentId: DOC.oneOnOne,
      quote: "On track — I just need you to confirm the cutover date so I can schedule it.",
      quoteAuthor: "Jane",
    },
    intent: "Pin the billing-migration ask",
  }),
  evt(200, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_cutover",
    durationMs: 5,
    result: {
      kind: "annotate.recorded",
      documentId: DOC.oneOnOne,
      ref: {
        documentId: DOC.oneOnOne,
        sourceType: "granola-meetings",
        sourceId: SRC.granola,
        documentType: "meeting",
        title: "1:1 with Jane",
        ts: ts("2026-05-11T17:30:00Z"),
      },
      quote: "On track — I just need you to confirm the cutover date so I can schedule it.",
      quoteAuthor: "Jane",
    },
  }),
  evt(300, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p1",
    tool: "plan",
    args: { complete: ["p1"] },
    intent: "Mark the meetings step done",
  }),
  evt(120, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p1",
    durationMs: 2,
    result: {
      kind: "plan.updated",
      items: [
        { id: "p1", label: "Pull your recent meetings with Jane", status: "done" },
        { id: "p2", label: "Scan open threads — email and chat", status: "in_progress" },
        { id: "p3", label: "Pin down what's still on you", status: "pending" },
      ],
    },
  }),

  // ── Step 2: the vendor decision — sent last autumn, still parked ─────
  evt(140, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      "\n\nThe cutover confirmation is on you. The other live one is the **Q4 vendor call** — she sent it last October and it never got closed; she re-flagged it in your May 1:1.",
  }),
  evt(700, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_fetch_assess",
    tool: "fetch_document",
    args: { documentId: DOC.gmailAssess },
    intent: "Read her assessment + recommendation",
  }),
  evt(1000, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_fetch_assess",
    durationMs: 196,
    result: {
      kind: "document",
      ref: {
        documentId: DOC.gmailAssess,
        sourceType: "gmail",
        sourceId: SRC.gmail,
        documentType: "email",
        title: "Q4 Vendor Assessment — final",
        ts: ts("2025-10-15T15:00:00Z"),
      },
      document: {
        id: DOC.gmailAssess,
        title: "Q4 Vendor Assessment — final",
        content:
          "Attaching the final Q4 vendor assessment — Bluestone, Greenfield, Apex against our procurement criteria (cost, SOC2 readiness, API depth, support). Bluestone is my top pick subject to a November SOC2 gap review. — Jane\nAttachment: Q4-Vendor-Assessment.pdf",
      },
    },
  }),
  evt(380, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_rec",
    tool: "annotate",
    args: {
      documentId: DOC.gmailAssess,
      quote: "Bluestone is my top pick subject to a November SOC2 gap review.",
      quoteAuthor: "Jane",
      note: "Sent Oct; still awaiting your call to start procurement",
    },
    intent: "Pin the recommendation + the ask on you",
  }),
  evt(200, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_rec",
    durationMs: 5,
    result: {
      kind: "annotate.recorded",
      documentId: DOC.gmailAssess,
      ref: {
        documentId: DOC.gmailAssess,
        sourceType: "gmail",
        sourceId: SRC.gmail,
        documentType: "email",
        title: "Q4 Vendor Assessment — final",
        ts: ts("2025-10-15T15:00:00Z"),
      },
      quote: "Bluestone is my top pick subject to a November SOC2 gap review.",
      quoteAuthor: "Jane",
      note: "Sent Oct; still awaiting your call to start procurement",
    },
  }),
  evt(300, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p2",
    tool: "plan",
    args: { complete: ["p2"] },
    intent: "Mark the threads step done",
  }),
  evt(120, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p2",
    durationMs: 2,
    result: {
      kind: "plan.updated",
      items: [
        { id: "p1", label: "Pull your recent meetings with Jane", status: "done" },
        { id: "p2", label: "Scan open threads — email and chat", status: "done" },
        { id: "p3", label: "Pin down what's still on you", status: "in_progress" },
      ],
    },
  }),

  // ── Step 3: the WhatsApp side of the thread + the meeting slot ───────
  evt(140, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta: "\n\nAnd here's what she actually said about the risk, on WhatsApp:",
  }),
  evt(650, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_fetch_wa",
    tool: "fetch_document",
    args: { documentId: DOC.waJane },
    intent: "Read the WhatsApp side of the vendor thread",
  }),
  evt(950, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_fetch_wa",
    durationMs: 171,
    result: {
      kind: "document",
      ref: {
        documentId: DOC.waJane,
        sourceType: "whatsapp-messages",
        sourceId: SRC.wa,
        documentType: "conversation",
        title: "Jane Doe — 2025-10-15",
        ts: ts("2025-10-15T14:07:00Z"),
      },
      document: {
        id: DOC.waJane,
        title: "Jane Doe",
        content:
          'Jane: "Here is the Q4 vendor assessment report we discussed."\nYou: "The Bluestone section is what I care about most."\nJane: "Their API is solid but the SOC2 timeline is the risk. It\'s all in the report."',
      },
    },
  }),
  evt(380, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_wa",
    tool: "annotate",
    args: {
      documentId: DOC.waJane,
      quote: "their API is solid but the SOC2 timeline is the risk. It's all in the report.",
      quoteAuthor: "Jane",
    },
    intent: "Pin Jane's SOC2 concern from the chat",
  }),
  evt(200, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_wa",
    durationMs: 5,
    result: {
      kind: "annotate.recorded",
      documentId: DOC.waJane,
      ref: {
        documentId: DOC.waJane,
        sourceType: "whatsapp-messages",
        sourceId: SRC.wa,
        documentType: "conversation",
        title: "Jane Doe — 2025-10-15",
        ts: ts("2025-10-15T14:07:00Z"),
      },
      quote: "their API is solid but the SOC2 timeline is the risk. It's all in the report.",
      quoteAuthor: "Jane",
    },
  }),
  evt(650, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_fetch_next",
    tool: "fetch_document",
    args: { documentId: DOC.calNext },
    intent: "Confirm the 1:1 slot",
  }),
  evt(850, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_fetch_next",
    durationMs: 138,
    result: {
      kind: "document",
      ref: {
        documentId: DOC.calNext,
        sourceType: "google-calendar",
        sourceId: SRC.cal,
        documentType: "event",
        title: "1:1 with Jane",
        ts: ts("2026-06-15T15:00:00Z"),
      },
      document: {
        id: DOC.calNext,
        title: "1:1 with Jane",
        content: "Mon 15 Jun 2026 · 15:00–15:30 · Mercury room · Attendees: You, Jane Doe",
      },
    },
  }),
  evt(300, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p3",
    tool: "plan",
    args: { complete: ["p3"] },
    intent: "Mark the summary step done",
  }),
  evt(120, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p3",
    durationMs: 2,
    result: {
      kind: "plan.updated",
      items: [
        { id: "p1", label: "Pull your recent meetings with Jane", status: "done" },
        { id: "p2", label: "Scan open threads — email and chat", status: "done" },
        { id: "p3", label: "Pin down what's still on you", status: "done" },
      ],
    },
  }),

  // ── Final brief ──────────────────────────────────────────────────────
  evt(300, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      "\n\n**Three things open with Jane — two are on you:**\n\n1. **Billing migration** — she's on track but waiting on you to **confirm the cutover date** so she can schedule it (from your May 1:1).\n2. **Q4 vendor decision** — she recommended **Bluestone** (pending a SOC2 gap review), sent it back in **October**, and re-flagged it in the 1:1. It's been parked ever since and still needs your **call to start procurement** — worth just closing at this 1:1.\n3. **SOC2 risk** — her one consistent worry across the report and WhatsApp; give her a straight answer on the timeline.\n\nPersonal: she asked you to **review her conference-talk abstract** before the CFP — easy goodwill, don't let it slip.\n\nYour 1:1 is **Mon 15 Jun, 15:00, Mercury room**.",
  }),
  evt(500, "agent.message.end", {
    sessionId: $S,
    messageId: $M,
    stopReason: "end_turn",
    usage: { inputTokens: 1620, outputTokens: 480, cacheReadTokens: 1180, cacheCreationTokens: 0 },
  }),
];

const out =
  "# Demo fixture — person-catchup scenario.\n" +
  "# Generated by build-person-catchup.mjs.\n" +
  "# People-graph showcase: on the eve of a 1:1, the agent assembles what's\n" +
  "# still open with one person by pulling across the channels she lives in —\n" +
  "# Granola meetings, Gmail (+ attached report), WhatsApp — and lands a crisp\n" +
  "# what's-on-you brief. Every pinned quote is grounded in the cited fixture.\n" +
  events.join("\n") +
  "\n";
writeFileSync(new URL("../person-catchup.jsonl", import.meta.url), out);
console.log(`wrote ${events.length} entries`);
