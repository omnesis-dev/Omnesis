// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Builds the tenancy-deposit demo fixture — the documents showcase: the
 * agent answers a two-part question by reading a CONTRACT (the tenancy
 * agreement PDF on Drive) for the hard facts and the EMAIL correspondence
 * (the property manager's note) for what was actually promised, and
 * cross-checks the one condition that could hold the deposit up.
 *
 * Scenario (today = Sun 5 Oct 2025): the lease is winding down. The user
 * asks when it ends and what Daniel said about getting the deposit back.
 * The two-step plan, written without foreknowledge:
 *
 *   1. Find the lease and the key dates. (The tenancy PDF gives the term
 *      end and the deposit amount + scheme.)
 *   2. Find any correspondence about the deposit. (His email spells out the
 *      return process — and its one condition, rent being clear, which the
 *      agent then checks against the Q4 rent reminder.)
 *
 * Run after edits:
 *   node evals/universes/default/agent-demos/_build/build-tenancy-deposit.mjs
 *
 * Routing triggers and placeholder declarations live in the sibling
 * `tenancy-deposit.meta.json`.
 */

import { writeFileSync } from "node:fs";

const $S = "$SESSION";
const $M = "$MSG";

const DOC = {
  lease: "$DOC_synth-gdrive-100",
  deposit: "$DOC_synth-gmail-property-004",
  rent: "$DOC_synth-gmail-property-003",
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
      "Let me dig into this — I'll pull the paperwork together and work out both the end date and the deposit.",
  }),

  // ── Plan ─────────────────────────────────────────────────────────────
  evt(300, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_setup",
    tool: "plan",
    args: {
      add: ["Find your lease and the key dates", "Find any correspondence about the deposit"],
    },
    intent: "Lay out the two steps",
  }),
  evt(120, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_setup",
    durationMs: 3,
    result: {
      kind: "plan.updated",
      items: [
        { id: "p1", label: "Find your lease and the key dates", status: "in_progress" },
        { id: "p2", label: "Find any correspondence about the deposit", status: "pending" },
      ],
    },
  }),

  // ── Step 1: the contract ─────────────────────────────────────────────
  evt(700, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_search_lease",
    tool: "search_documents",
    args: { query: "tenancy agreement lease term deposit", limit: 5 },
    intent: "Find the lease and anything about the deposit",
  }),
  evt(1300, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_search_lease",
    durationMs: 219,
    result: {
      kind: "search.results",
      query: "tenancy agreement lease term deposit",
      durationMs: 219,
      candidates: 4,
      results: [
        {
          documentId: DOC.lease,
          sourceType: "google-drive",
          sourceId: "google-drive:self",
          documentType: "file",
          title: "Tenancy agreement — 27 Eaton Square.pdf",
          snippet:
            "Assured Shorthold Tenancy · Term: 12 months from 1 January 2025 to 31 December 2025 · Deposit: £4,800.",
          ts: ts("2024-12-18T10:00:00Z"),
        },
        {
          documentId: DOC.deposit,
          sourceType: "gmail",
          sourceId: "gmail:self",
          documentType: "email",
          title: "Your deposit — how the return works at end of tenancy",
          snippet:
            "Daniel Harper · protected with the Deposit Custody Service · full amount back within 10 working days of check-out.",
          ts: ts("2025-10-02T09:20:00Z"),
        },
      ],
    },
  }),
  evt(650, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_fetch_lease",
    tool: "fetch_document",
    args: { documentId: DOC.lease },
    intent: "Read the term and deposit clauses",
  }),
  evt(1000, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_fetch_lease",
    durationMs: 241,
    result: {
      kind: "document",
      ref: {
        documentId: DOC.lease,
        sourceType: "google-drive",
        sourceId: "google-drive:self",
        documentType: "file",
        title: "Tenancy agreement — 27 Eaton Square.pdf",
        ts: ts("2024-12-18T10:00:00Z"),
      },
      document: {
        id: DOC.lease,
        title: "Tenancy agreement — 27 Eaton Square.pdf",
        content:
          "ASSURED SHORTHOLD TENANCY AGREEMENT\nProperty: Flat 4, 27 Eaton Square, London SW1W 9DG\nProperty Manager: Daniel Harper\nTenant: John Smith\nTerm: 12 months from 1 January 2025 to 31 December 2025.\nMonthly rent: £3,200 payable on the 1st of each month.\nDeposit: £4,800 held with the Deposit Custody Service.",
      },
    },
  }),
  evt(380, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_term",
    tool: "annotate",
    args: {
      documentId: DOC.lease,
      quote: "Term: 12 months from 1 January 2025 to 31 December 2025.",
    },
    intent: "Pin the term end date",
  }),
  evt(200, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_term",
    durationMs: 5,
    result: {
      kind: "annotate.recorded",
      documentId: DOC.lease,
      ref: {
        documentId: DOC.lease,
        sourceType: "google-drive",
        sourceId: "google-drive:self",
        documentType: "file",
        title: "Tenancy agreement — 27 Eaton Square.pdf",
        ts: ts("2024-12-18T10:00:00Z"),
      },
      quote: "Term: 12 months from 1 January 2025 to 31 December 2025.",
    },
  }),
  evt(320, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_deposit_clause",
    tool: "annotate",
    args: {
      documentId: DOC.lease,
      quote: "Deposit: £4,800 held with the Deposit Custody Service.",
    },
    intent: "Pin the deposit amount + scheme",
  }),
  evt(200, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_deposit_clause",
    durationMs: 5,
    result: {
      kind: "annotate.recorded",
      documentId: DOC.lease,
      ref: {
        documentId: DOC.lease,
        sourceType: "google-drive",
        sourceId: "google-drive:self",
        documentType: "file",
        title: "Tenancy agreement — 27 Eaton Square.pdf",
        ts: ts("2024-12-18T10:00:00Z"),
      },
      quote: "Deposit: £4,800 held with the Deposit Custody Service.",
    },
  }),
  evt(160, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      "\n\nThe lease runs to **31 December 2025** — a fixed 12-month term, so it ends on that date. Your deposit is **£4,800**, held with the Deposit Custody Service.",
  }),
  evt(300, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p1",
    tool: "plan",
    args: { complete: ["p1"] },
    intent: "Mark the lease-lookup step done",
  }),
  evt(120, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p1",
    durationMs: 2,
    result: {
      kind: "plan.updated",
      items: [
        { id: "p1", label: "Find your lease and the key dates", status: "done" },
        { id: "p2", label: "Find any correspondence about the deposit", status: "in_progress" },
      ],
    },
  }),

  // ── Step 2: what Daniel actually said, + the one condition ───────────
  evt(140, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta: "\n\nNow Daniel's note on the return itself.",
  }),
  evt(700, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_fetch_deposit",
    tool: "fetch_document",
    args: { documentId: DOC.deposit },
    intent: "Read Daniel's deposit-return email",
  }),
  evt(1000, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_fetch_deposit",
    durationMs: 187,
    result: {
      kind: "document",
      ref: {
        documentId: DOC.deposit,
        sourceType: "gmail",
        sourceId: "gmail:self",
        documentType: "email",
        title: "Your deposit — how the return works at end of tenancy",
        ts: ts("2025-10-02T09:20:00Z"),
      },
      document: {
        id: DOC.deposit,
        title: "Your deposit — how the return works at end of tenancy",
        content:
          "Your deposit of £4,800 is protected with the Deposit Custody Service (scheme reference DCS-4471-EAT). Provided there's no damage beyond fair wear and tear and the rent is clear, you'll receive the full amount back within 10 working days of check-out. I'll send the check-out inventory form in early December so we can book the final inspection.\n— Daniel Harper, Acme Property Management",
      },
    },
  }),
  evt(380, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_return",
    tool: "annotate",
    args: {
      documentId: DOC.deposit,
      quote: "you'll receive the full amount back within 10 working days of check-out",
      quoteAuthor: "Daniel Harper",
    },
    intent: "Pin the return terms",
  }),
  evt(200, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_return",
    durationMs: 5,
    result: {
      kind: "annotate.recorded",
      documentId: DOC.deposit,
      ref: {
        documentId: DOC.deposit,
        sourceType: "gmail",
        sourceId: "gmail:self",
        documentType: "email",
        title: "Your deposit — how the return works at end of tenancy",
        ts: ts("2025-10-02T09:20:00Z"),
      },
      quote: "you'll receive the full amount back within 10 working days of check-out",
      quoteAuthor: "Daniel Harper",
    },
  }),
  evt(160, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      "\n\nThe return hinges on one thing you can check right now — **the rent being clear**. Let me see what's still due before check-out.",
  }),
  evt(700, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_search_rent",
    tool: "search_documents",
    args: { query: "rent due standing order before end of tenancy", limit: 3 },
    intent: "Check what rent is still due before check-out",
  }),
  evt(1050, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_search_rent",
    durationMs: 141,
    result: {
      kind: "search.results",
      query: "rent due standing order before end of tenancy",
      durationMs: 141,
      candidates: 2,
      results: [
        {
          documentId: DOC.rent,
          sourceType: "gmail",
          sourceId: "gmail:self",
          documentType: "email",
          title: "Rent reminder — October",
          snippet:
            "Daniel Harper · £3,200/month standing order · instalments 1 Oct, 1 Nov, 1 Dec before the term ends.",
          ts: ts("2025-09-25T09:00:00Z"),
        },
      ],
    },
  }),
  evt(360, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_rent",
    tool: "annotate",
    args: {
      documentId: DOC.rent,
      note: "£3,200/month standing order — 1 Oct, 1 Nov, 1 Dec instalments must all clear for the full deposit return",
    },
    intent: "Flag the rent condition",
  }),
  evt(200, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_rent",
    durationMs: 5,
    result: {
      kind: "annotate.recorded",
      documentId: DOC.rent,
      ref: {
        documentId: DOC.rent,
        sourceType: "gmail",
        sourceId: "gmail:self",
        documentType: "email",
        title: "Rent reminder — October",
        ts: ts("2025-09-25T09:00:00Z"),
      },
      note: "£3,200/month standing order — 1 Oct, 1 Nov, 1 Dec instalments must all clear for the full deposit return",
    },
  }),
  evt(300, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p2",
    tool: "plan",
    args: { complete: ["p2"] },
    intent: "Mark the deposit step done",
  }),
  evt(120, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p2",
    durationMs: 2,
    result: {
      kind: "plan.updated",
      items: [
        { id: "p1", label: "Find your lease and the key dates", status: "done" },
        { id: "p2", label: "Find any correspondence about the deposit", status: "done" },
      ],
    },
  }),

  // ── Final answer — lead with the deadline hiding in the inbox ────────
  evt(300, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      "\n\n**Two dates to hold.**\n\n- Your tenancy ends on **31 December 2025** (fixed 12-month term).\n- But the one to diarise is **early December**, when Daniel sends the **check-out inventory form** to book the final inspection — that's what starts the deposit moving, so watch for it.\n\nOn the deposit itself — **£4,800**, held with the Deposit Custody Service (ref DCS-4471-EAT). Daniel says you'll get the **full amount back within 10 working days of check-out**, provided there's no damage beyond fair wear and tear and the rent's clear. You're on a **£3,200 monthly standing order** — with **1 Nov and 1 Dec** still to go before check-out (the 1 Oct one just fell due), keep those clear and the flat tidy, and the £4,800 comes straight back.",
  }),
  evt(500, "agent.message.end", {
    sessionId: $S,
    messageId: $M,
    stopReason: "end_turn",
    usage: { inputTokens: 1490, outputTokens: 440, cacheReadTokens: 1080, cacheCreationTokens: 0 },
  }),
];

const out =
  "# Demo fixture — tenancy-deposit scenario.\n" +
  "# Generated by build-tenancy-deposit.mjs.\n" +
  "# Documents showcase: the agent reads a contract PDF (tenancy agreement)\n" +
  "# for the hard facts and the property manager's email for what was\n" +
  "# promised, then cross-checks the one condition (rent clear) against the\n" +
  "# rent reminder, and leads with the check-out deadline buried in the\n" +
  "# inbox — one grounded answer across Drive + Gmail.\n" +
  events.join("\n") +
  "\n";
writeFileSync(new URL("../tenancy-deposit.jsonl", import.meta.url), out);
console.log(`wrote ${events.length} entries`);
