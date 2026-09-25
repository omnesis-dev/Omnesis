// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Builds the trip-spending demo fixture — the finance showcase that the
 * agent correlates a booking-confirmation EMAIL against the matching
 * card TRANSACTION, tallies a trip's real cost, and confirms a friend's
 * repayment landed — one answer stitched across Gmail, the bank feed,
 * WhatsApp and the calendar.
 *
 * Scenario (today = Tue 1 Jul 2025): a month after a long weekend in
 * Lisbon with Alex, the user asks what it actually cost and whether Alex
 * ever paid back his half. The three-step plan is written without
 * foreknowledge so the demo feels like genuine discovery:
 *
 *   1. Find the trip and what was booked. (Surfaces the calendar hold
 *      plus the flight + apartment confirmation emails.)
 *   2. Total what actually hit the card over the trip window — and note
 *      that the €318.60 Meridian Air line matches the flight email to
 *      the cent.
 *   3. Check for Alex's repayment — a WhatsApp promise, then the €379
 *      credit that settles it.
 *
 * Run after edits:
 *   node evals/universes/default/agent-demos/_build/build-trip-spending.mjs
 *
 * Routing triggers and placeholder declarations live in the sibling
 * `trip-spending.meta.json`.
 */

import { writeFileSync } from "node:fs";

const $S = "$SESSION";
const $M = "$MSG";

const DOC = {
  cal: "$DOC_synth-gcal-lisbon",
  flight: "$DOC_synth-gmail-trip-flight",
  stay: "$DOC_synth-gmail-trip-stay",
  waAlex: "$DOC_synth-whatsapp-trip-alex",
  // Individual bank transactions (enable-banking) — cited so the timeline
  // mingles finance records with the emails + chat, not just tabulates them.
  meridianTxn: "$DOC_synth-eb-acct-main:synth-eb-030",
  alexTxn: "$DOC_synth-eb-acct-main:synth-eb-034",
};

// Ref for a cited bank transaction (enable-banking, default universe).
const BANK_REF = {
  sourceType: "enable-banking-accounts",
  sourceId: "enable-banking-accounts:revolut-de",
  documentType: "transaction",
};

const ts = (iso) => Date.parse(iso);

const BANK_SOURCES = [
  {
    sourceId: "enable-banking-accounts:revolut-de",
    sourceType: "enable-banking-accounts",
    displayName: "Bank Transactions",
  },
];
const BANK_SUBJECTS = ["Main account (EUR)"];

// Real bank_transactions analytics schema (packages/providers/enable-banking):
// signed `amount` (negative = debit), `counterparty_name`, `description` —
// no merchant / amount_eur / category / direction columns.
const SPEND_SQL = [
  "SELECT booking_date, counterparty_name, amount, description",
  "FROM bank_transactions",
  "WHERE amount < 0",
  "  AND (booking_date BETWEEN DATE '2025-06-12' AND DATE '2025-06-15'",
  "       OR counterparty_name IN ('Meridian Air', 'Casa Alfama Stays'))",
  "ORDER BY booking_date",
].join("\n");

// Multiplier on every inter-event gap — lets the demo breathe in a live
// walk-through (viewers get time to read each step before the next lands).
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
      "Let me reconstruct it — I'll find the trip and what you booked, add up what actually hit your card, then check whether Alex settled his half.",
  }),

  // ── Plan: three items ────────────────────────────────────────────────
  evt(300, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_setup",
    tool: "plan",
    args: {
      add: [
        "Find the trip and what you booked",
        "Total what hit your card",
        "Check if Alex paid you back",
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
        { id: "p1", label: "Find the trip and what you booked", status: "in_progress" },
        { id: "p2", label: "Total what hit your card", status: "pending" },
        { id: "p3", label: "Check if Alex paid you back", status: "pending" },
      ],
    },
  }),

  // ── Step 1: the trip + the two booking confirmations ─────────────────
  evt(700, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_search_trip",
    tool: "search_documents",
    args: { query: "Lisbon trip flights apartment", limit: 6 },
    intent: "Find the trip and anything booked for it",
  }),
  evt(1300, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_search_trip",
    durationMs: 231,
    result: {
      kind: "search.results",
      query: "Lisbon trip flights apartment",
      durationMs: 231,
      candidates: 3,
      results: [
        {
          documentId: DOC.cal,
          sourceType: "google-calendar",
          sourceId: "google-calendar:self",
          documentType: "event",
          title: "Lisbon trip (with Alex)",
          snippet: "12–15 Jun · Lisbon, Portugal · flights Meridian Air, apartment in Alfama.",
          ts: ts("2025-06-12T00:00:00Z"),
        },
        {
          documentId: DOC.flight,
          sourceType: "gmail",
          sourceId: "gmail:self",
          documentType: "email",
          title: "Your Meridian Air booking is confirmed — London to Lisbon",
          snippet:
            "Passengers: John Smith, Alex Chen · 2× return · Total charged: EUR 318.60 to card ending 4471.",
          ts: ts("2025-05-20T18:12:00Z"),
        },
        {
          documentId: DOC.stay,
          sourceType: "gmail",
          sourceId: "gmail:self",
          documentType: "email",
          title: "Reservation confirmed — Casa Alfama Stays (12–15 Jun)",
          snippet: "One-bedroom, Alfama · 3 nights · Total: EUR 440.00 (paid in full).",
          ts: ts("2025-05-22T10:05:00Z"),
        },
      ],
    },
  }),
  evt(650, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_fetch_flight",
    tool: "fetch_document",
    args: { documentId: DOC.flight },
    intent: "Read the flight confirmation for the exact fare",
  }),
  evt(950, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_fetch_flight",
    durationMs: 214,
    result: {
      kind: "document",
      ref: {
        documentId: DOC.flight,
        sourceType: "gmail",
        sourceId: "gmail:self",
        documentType: "email",
        title: "Your Meridian Air booking is confirmed — London to Lisbon",
        ts: ts("2025-05-20T18:12:00Z"),
      },
      document: {
        id: DOC.flight,
        title: "Your Meridian Air booking is confirmed — London to Lisbon",
        content:
          "Booking reference: MA7F2K9\nPassengers: John Smith, Alex Chen\nOutbound Thu 12 Jun · LHR 07:20 → LIS 09:55\nReturn Sun 15 Jun · LIS 18:40 → LHR 21:20\n2× return fare (incl. taxes & 1 bag each)\nTotal charged: EUR 318.60 to card ending 4471",
      },
    },
  }),
  evt(380, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_flight",
    tool: "annotate",
    args: {
      documentId: DOC.flight,
      quote: "Total charged: EUR 318.60 to card ending 4471",
    },
    intent: "Pin the flight total",
  }),
  evt(200, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_flight",
    durationMs: 5,
    result: {
      kind: "annotate.recorded",
      documentId: DOC.flight,
      ref: {
        documentId: DOC.flight,
        sourceType: "gmail",
        sourceId: "gmail:self",
        documentType: "email",
        title: "Your Meridian Air booking is confirmed — London to Lisbon",
        ts: ts("2025-05-20T18:12:00Z"),
      },
      quote: "Total charged: EUR 318.60 to card ending 4471",
    },
  }),
  evt(380, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_stay",
    tool: "annotate",
    args: {
      documentId: DOC.stay,
      quote: "Total: EUR 440.00 (paid in full)",
    },
    intent: "Pin the apartment total",
  }),
  evt(200, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_stay",
    durationMs: 5,
    result: {
      kind: "annotate.recorded",
      documentId: DOC.stay,
      ref: {
        documentId: DOC.stay,
        sourceType: "gmail",
        sourceId: "gmail:self",
        documentType: "email",
        title: "Reservation confirmed — Casa Alfama Stays (12–15 Jun)",
        ts: ts("2025-05-22T10:05:00Z"),
      },
      quote: "Total: EUR 440.00 (paid in full)",
    },
  }),
  evt(300, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p1",
    tool: "plan",
    args: { complete: ["p1"] },
    intent: "Mark the trip-lookup step done",
  }),
  evt(120, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p1",
    durationMs: 2,
    result: {
      kind: "plan.updated",
      items: [
        { id: "p1", label: "Find the trip and what you booked", status: "done" },
        { id: "p2", label: "Total what hit your card", status: "in_progress" },
        { id: "p3", label: "Check if Alex paid you back", status: "pending" },
      ],
    },
  }),

  // ── Step 2: the card spend, with the flight line matched to the email ─
  evt(140, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      "\n\nIn May you booked the **flights (€318.60)** and the **apartment (€440)**. Now pull everything the card saw across the trip itself.",
  }),
  evt(900, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_sql_spend",
    tool: "run_sql",
    args: { sql: SPEND_SQL },
    intent: "Every charge on the card across the trip window",
  }),
  evt(1400, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_sql_spend",
    durationMs: 176,
    result: {
      kind: "sql.rows",
      sql: SPEND_SQL,
      columns: ["booking_date", "counterparty_name", "amount", "description"],
      rows: [
        ["2025-05-20", "Meridian Air", -318.6, "Flights LON-LIS return x2 — booking MA7F2K9"],
        ["2025-05-22", "Casa Alfama Stays", -440.0, "Apartment 3 nights — reservation CA-58817"],
        ["2025-06-12", "Miradouro Coffee", -11.2, "Coffee"],
        ["2025-06-13", "Taberna do Fado", -74.5, "Dinner"],
        ["2025-06-13", "Tram 28 Tours", -58.0, "Tickets x2"],
        ["2025-06-14", "Café Graça", -42.1, "Lunch in Lisbon"],
        ["2025-06-14", "Oceanário Lisboa", -38.0, "Tickets x2"],
      ],
      rowCount: 7,
      durationMs: 176,
      sources: BANK_SOURCES,
      subjects: BANK_SUBJECTS,
    },
  }),
  evt(160, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      "\n\nThe trip ran **€982.40** across 7 charges — bookings plus food, the tram and the aquarium. The one worth double-checking is the **€318.60 Meridian Air** line: let me open it and reconcile against the booking email, in case it's a duplicate.",
  }),
  evt(650, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_fetch_meridian",
    tool: "fetch_document",
    args: { documentId: DOC.meridianTxn },
    intent: "Open the €318.60 Meridian Air charge to reconcile against the flight email",
  }),
  evt(900, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_fetch_meridian",
    durationMs: 148,
    result: {
      kind: "document",
      ref: {
        documentId: DOC.meridianTxn,
        ...BANK_REF,
        title: "Meridian Air — -318.60 EUR",
        ts: ts("2025-05-20T00:00:00Z"),
      },
      document: {
        id: DOC.meridianTxn,
        title: "Meridian Air — -318.60 EUR",
        content:
          "20 May 2025 · -318.60 EUR · Meridian Air · Flights LON-LIS return x2 · booking MA7F2K9",
      },
    },
  }),
  evt(380, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_meridian",
    tool: "annotate",
    args: {
      documentId: DOC.meridianTxn,
      quote:
        "20 May 2025 · -318.60 EUR · Meridian Air · Flights LON-LIS return x2 · booking MA7F2K9",
      note: "Reconciles to the flight email to the cent (same €318.60, same booking ref) — flights, not a double charge",
    },
    intent: "Pin the bank charge alongside the booking email",
  }),
  evt(200, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_meridian",
    durationMs: 5,
    result: {
      kind: "annotate.recorded",
      documentId: DOC.meridianTxn,
      ref: {
        documentId: DOC.meridianTxn,
        ...BANK_REF,
        title: "Meridian Air — -318.60 EUR",
        ts: ts("2025-05-20T00:00:00Z"),
      },
      quote:
        "20 May 2025 · -318.60 EUR · Meridian Air · Flights LON-LIS return x2 · booking MA7F2K9",
      note: "Reconciles to the flight email to the cent (same €318.60, same booking ref) — flights, not a double charge",
    },
  }),
  evt(300, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p2",
    tool: "plan",
    args: { complete: ["p2"] },
    intent: "Mark the totalling step done",
  }),
  evt(120, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p2",
    durationMs: 2,
    result: {
      kind: "plan.updated",
      items: [
        { id: "p1", label: "Find the trip and what you booked", status: "done" },
        { id: "p2", label: "Total what hit your card", status: "done" },
        { id: "p3", label: "Check if Alex paid you back", status: "in_progress" },
      ],
    },
  }),

  // ── Step 3: Alex's half — the promise, then the credit ───────────────
  evt(140, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      "\n\nNow Alex — did his half ever land? Let me pull the thread where you'd have squared it up.",
  }),
  evt(750, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_fetch_wa",
    tool: "fetch_document",
    args: { documentId: DOC.waAlex },
    intent: "Read the thread where the split was agreed",
  }),
  evt(1000, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_fetch_wa",
    durationMs: 188,
    result: {
      kind: "document",
      ref: {
        documentId: DOC.waAlex,
        sourceType: "whatsapp-messages",
        sourceId: "whatsapp-messages:+15550100",
        documentType: "conversation",
        title: "Alex Chen — 2025-05-22",
        ts: ts("2025-05-22T19:40:00Z"),
      },
      document: {
        id: DOC.waAlex,
        title: "Alex Chen",
        content:
          'You: "Half of (318.60 + 440) = €379.30. Call it €379."\nAlex: "Perfect. I\'ll send it once my salary lands, probably the 18th."\nAlex (18 Jun): "Sent you €379 for Lisbon just now"',
      },
    },
  }),
  evt(380, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_wa",
    tool: "annotate",
    args: {
      documentId: DOC.waAlex,
      quote: "Sent you €379 for Lisbon just now",
      quoteAuthor: "Alex",
    },
    intent: "Pin Alex's confirmation",
  }),
  evt(200, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_wa",
    durationMs: 5,
    result: {
      kind: "annotate.recorded",
      documentId: DOC.waAlex,
      ref: {
        documentId: DOC.waAlex,
        sourceType: "whatsapp-messages",
        sourceId: "whatsapp-messages:+15550100",
        documentType: "conversation",
        title: "Alex Chen — 2025-05-22",
        ts: ts("2025-05-22T19:40:00Z"),
      },
      quote: "Sent you €379 for Lisbon just now",
      quoteAuthor: "Alex",
    },
  }),
  evt(700, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_search_repay",
    tool: "search_documents",
    args: { query: "incoming credit from Alex Chen Lisbon repayment", limit: 3 },
    intent: "Find the matching credit on the bank feed",
  }),
  evt(1050, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_search_repay",
    durationMs: 138,
    result: {
      kind: "search.results",
      query: "incoming credit from Alex Chen Lisbon repayment",
      durationMs: 138,
      candidates: 1,
      results: [
        {
          documentId: DOC.alexTxn,
          ...BANK_REF,
          title: "Alex Chen — +379.00 EUR",
          snippet: "18 Jun 2025 · +379.00 EUR from Alex Chen · Lisbon trip — my half",
          ts: ts("2025-06-18T00:00:00Z"),
        },
      ],
    },
  }),
  evt(380, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_alextxn",
    tool: "annotate",
    args: {
      documentId: DOC.alexTxn,
      quote: "18 Jun 2025 · +379.00 EUR from Alex Chen · Lisbon trip — my half",
      note: "The credit behind Alex's “sent you €379” message — landed 18 Jun",
    },
    intent: "Pin the bank credit alongside Alex's message",
  }),
  evt(200, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_alextxn",
    durationMs: 5,
    result: {
      kind: "annotate.recorded",
      documentId: DOC.alexTxn,
      ref: {
        documentId: DOC.alexTxn,
        ...BANK_REF,
        title: "Alex Chen — +379.00 EUR",
        ts: ts("2025-06-18T00:00:00Z"),
      },
      quote: "18 Jun 2025 · +379.00 EUR from Alex Chen · Lisbon trip — my half",
      note: "The credit behind Alex's “sent you €379” message — landed 18 Jun",
    },
  }),
  evt(300, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p3",
    tool: "plan",
    args: { complete: ["p3"] },
    intent: "Mark the repayment step done",
  }),
  evt(120, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p3",
    durationMs: 2,
    result: {
      kind: "plan.updated",
      items: [
        { id: "p1", label: "Find the trip and what you booked", status: "done" },
        { id: "p2", label: "Total what hit your card", status: "done" },
        { id: "p3", label: "Check if Alex paid you back", status: "done" },
      ],
    },
  }),

  // ── Final verdict ────────────────────────────────────────────────────
  evt(300, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      "\n\n**The Lisbon long weekend cost €982.40 on your card.**\n\n- **Bookings** (May): flights €318.60 + apartment €440 — the €318.60 charge reconciles to the Meridian Air confirmation to the cent.\n- **On the ground** (12–15 Jun): €223.80 across coffee, lunch, dinner, the tram and the aquarium.\n- **Alex's half**: he agreed **€379.30** and sent **€379** on **18 Jun** — matched to the credit on your statement. He rounded down, so he's 30 cents light. Call it square.\n\nYour true out-of-pocket: **€603.40**.",
  }),
  evt(500, "agent.message.end", {
    sessionId: $S,
    messageId: $M,
    stopReason: "end_turn",
    usage: { inputTokens: 1520, outputTokens: 460, cacheReadTokens: 1100, cacheCreationTokens: 0 },
  }),
];

const out =
  "# Demo fixture — trip-spending scenario.\n" +
  "# Generated by build-trip-spending.mjs.\n" +
  "# Finance showcase: the agent correlates a booking-confirmation email\n" +
  "# against the matching card transaction, totals a trip's real cost, and\n" +
  "# confirms a friend's repayment cleared — one answer across Gmail, the\n" +
  "# bank feed, WhatsApp and the calendar.\n" +
  events.join("\n") +
  "\n";
writeFileSync(new URL("../trip-spending.jsonl", import.meta.url), out);
console.log(`wrote ${events.length} entries`);
