// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Builds the birthday-gift-discovery demo fixture — the showcase for
 * cross-source memory: the agent doesn't just find ideas Claire shared,
 * it checks whether any of them were *already bought* so you don't gift
 * the same thing twice.
 *
 * Scenario: user opens with "Claire's birthday's coming up — did she
 * ever mention things she actually wants? Don't want to get her
 * something we already have." The agent works a three-step plan:
 *
 *   1. Search Claire's messages for things she wants (Gmail + WhatsApp).
 *   2. For each idea, check purchase history for a buy/booking trace —
 *      the crystal vase turns up an Amazon order from a previous year,
 *      so it's already off the table.
 *   3. Summarise the live candidates with a recommendation.
 *
 * The product/shop names are invented (Marlowe & Finch, Lumen Baths,
 * Flourhouse, the 'Wren' vase) and grounded in the synth corpus so the
 * citations resolve against a live demo gateway.
 *
 * Run after edits:
 *   node evals/universes/default/agent-demos/_build/build-birthday-gifts.mjs
 *
 * Routing triggers and placeholder declarations live in the sibling
 * `birthday-gifts.meta.json` file.
 */

import { writeFileSync } from "node:fs";

const $S = "$SESSION";
const $M = "$MSG";

const DOC = {
  giftEmail: "$DOC_synth-gmail-claire-001",
  amazon: "$DOC_synth-gmail-claire-002",
  cabin: "$DOC_synth-gmail-claire-003",
  tess: "$DOC_synth-gmail-claire-005",
  sourdoughWA: "$DOC_synth-whatsapp-claire-001",
  milkWA: "$DOC_synth-whatsapp-claire-002",
};

// Invented gift ideas — fully fictional shops/products, example.com URLs.
const NECKLACE_URL = "https://example.com/marlowe-finch/interlock-pendant";
const VASE_URL = "https://example.com/p/wren-glass-vase";
const SPA_URL = "https://example.com/lumen-baths";
const WORKSHOP_URL = "https://example.com/flourhouse/sourdough";

function evt(afterMs, type, payload) {
  return JSON.stringify({ afterMs, event: { type, payload } });
}

const events = [
  evt(400, "agent.message.start", { sessionId: $S, messageId: $M, role: "assistant" }),

  // ── Plan: three steps ────────────────────────────────────────────────
  evt(260, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_setup",
    tool: "plan",
    args: {
      add: ["Find ideas Claire has shared", "Check what's already been bought", "Recommend"],
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
        { id: "p1", label: "Find ideas Claire has shared", status: "in_progress" },
        { id: "p2", label: "Check what's already been bought", status: "pending" },
        { id: "p3", label: "Recommend", status: "pending" },
      ],
    },
  }),

  // ── Step 1: search everything Claire said she wants ──────────────────
  evt(900, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_search_claire",
    tool: "search_documents",
    args: {
      query: 'with:"Claire Smith" things she wants or would love',
      limit: 8,
    },
    intent: "Surface everything Claire has flagged as something she'd love",
  }),
  evt(1800, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_search_claire",
    durationMs: 684,
    result: {
      kind: "search.results",
      query: 'with:"Claire Smith" things she wants or would love',
      durationMs: 684,
      candidates: 31,
      results: [
        {
          documentId: DOC.giftEmail,
          sourceType: "gmail",
          sourceId: "gmail:self",
          documentType: "email",
          title: "These are the things I actually want (so you stop asking)",
          snippet:
            "hey, you keep asking, so here you go — a few ideas: I really like Marlowe & Finch — found this one: https://example.com/marlowe-finch/interlock-pendant…",
          ts: 1713813240000,
        },
        {
          documentId: DOC.sourdoughWA,
          sourceType: "whatsapp-messages",
          sourceId: "whatsapp-messages:self",
          documentType: "conversation",
          title: "Claire — 2025-02-08",
          snippet:
            'Claire: "We could do this workshop https://example.com/flourhouse/sourdough I\'ve always wanted to learn sourdough"',
          ts: 1739010780000,
        },
        {
          documentId: DOC.tess,
          sourceType: "gmail",
          sourceId: "gmail:self",
          documentType: "email",
          title: "Tess's birthday — present idea?",
          snippet:
            "Tess turns 6 next month. She is OBSESSED with dinosaurs right now. I'm leaning toward the big dino dig kit…",
          ts: 1762200300000,
        },
        {
          documentId: DOC.cabin,
          sourceType: "gmail",
          sourceId: "gmail:self",
          documentType: "email",
          title: "Weekend at the cabin — confirm?",
          snippet:
            "Booking closes tomorrow — are we still on for the cabin the weekend of the 18th? Sam and Lila are in if we are.",
          ts: 1752146400000,
        },
        {
          documentId: DOC.milkWA,
          sourceType: "whatsapp-messages",
          sourceId: "whatsapp-messages:self",
          documentType: "conversation",
          title: "Claire — 2025-09-15",
          snippet:
            'Claire: "can you pick up milk on the way home" · "and bread. and probably wine actually"',
          ts: 1757960040000,
        },
      ],
    },
  }),

  // ── Step 1b: read the gift email in full ─────────────────────────────
  evt(900, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_fetch_giftemail",
    tool: "fetch_document",
    args: { documentId: DOC.giftEmail },
    intent: "Read the full gift-ideas email",
  }),
  evt(1400, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_fetch_giftemail",
    durationMs: 287,
    result: {
      kind: "document",
      ref: {
        documentId: DOC.giftEmail,
        sourceType: "gmail",
        sourceId: "gmail:self",
        documentType: "email",
        title: "These are the things I actually want (so you stop asking)",
        ts: 1713813240000,
      },
      document: {
        id: DOC.giftEmail,
        title: "These are the things I actually want (so you stop asking)",
        content:
          "hey, you keep asking, so here you go — a few ideas:\n\n" +
          `I really like Marlowe & Finch — found this one: ${NECKLACE_URL}\n\n` +
          `I found this vase on amazon, it would go well with our dining table :)\n${VASE_URL}\n\n` +
          `Steph told me about Lumen Baths, apparently they do great massages :)\n${SPA_URL}\n\n` +
          "any of these would be amazing. love you x\n\nC",
      },
    },
  }),

  // ── Step 1c: pin each idea with Claire's own words ───────────────────
  evt(700, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_necklace",
    tool: "annotate",
    args: {
      documentId: DOC.giftEmail,
      quote: `I really like Marlowe & Finch — found this one: ${NECKLACE_URL}`,
      quoteAuthor: "Claire",
    },
    intent: "Annotate Claire's reasoning for the necklace",
  }),
  evt(220, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_necklace",
    durationMs: 6,
    result: {
      kind: "annotate.recorded",
      documentId: DOC.giftEmail,
      ref: {
        documentId: DOC.giftEmail,
        sourceType: "gmail",
        sourceId: "gmail:self",
        documentType: "email",
        title: "These are the things I actually want (so you stop asking)",
        ts: 1713813240000,
      },
      quote: `I really like Marlowe & Finch — found this one: ${NECKLACE_URL}`,
      quoteAuthor: "Claire",
    },
  }),
  evt(220, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_vase",
    tool: "annotate",
    args: {
      documentId: DOC.giftEmail,
      quote: "I found this vase on amazon, it would go well with our dining table :)",
      quoteAuthor: "Claire",
    },
    intent: "Annotate Claire's reasoning for the vase",
  }),
  evt(220, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_vase",
    durationMs: 7,
    result: {
      kind: "annotate.recorded",
      documentId: DOC.giftEmail,
      ref: {
        documentId: DOC.giftEmail,
        sourceType: "gmail",
        sourceId: "gmail:self",
        documentType: "email",
        title: "These are the things I actually want (so you stop asking)",
        ts: 1713813240000,
      },
      quote: "I found this vase on amazon, it would go well with our dining table :)",
      quoteAuthor: "Claire",
    },
  }),
  evt(220, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_massage",
    tool: "annotate",
    args: {
      documentId: DOC.giftEmail,
      quote: "Steph told me about Lumen Baths, apparently they do great massages :)",
      quoteAuthor: "Claire",
    },
    intent: "Annotate Claire's reasoning for the spa day",
  }),
  evt(220, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_massage",
    durationMs: 6,
    result: {
      kind: "annotate.recorded",
      documentId: DOC.giftEmail,
      ref: {
        documentId: DOC.giftEmail,
        sourceType: "gmail",
        sourceId: "gmail:self",
        documentType: "email",
        title: "These are the things I actually want (so you stop asking)",
        ts: 1713813240000,
      },
      quote: "Steph told me about Lumen Baths, apparently they do great massages :)",
      quoteAuthor: "Claire",
    },
  }),
  evt(220, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_sourdough",
    tool: "annotate",
    args: {
      documentId: DOC.sourdoughWA,
      quote:
        "We could do this workshop https://example.com/flourhouse/sourdough I've always wanted to learn sourdough",
      quoteAuthor: "Claire",
    },
    intent: "Annotate Claire's sourdough-workshop mention",
  }),
  evt(220, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_sourdough",
    durationMs: 6,
    result: {
      kind: "annotate.recorded",
      documentId: DOC.sourdoughWA,
      ref: {
        documentId: DOC.sourdoughWA,
        sourceType: "whatsapp-messages",
        sourceId: "whatsapp-messages:self",
        documentType: "conversation",
        title: "Claire — 2025-02-08",
        ts: 1739010780000,
      },
      quote:
        "We could do this workshop https://example.com/flourhouse/sourdough I've always wanted to learn sourdough",
      quoteAuthor: "Claire",
    },
  }),

  // ── Mark plan step 1 done, advance to step 2 ─────────────────────────
  evt(300, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_complete_p1",
    tool: "plan",
    args: { complete: ["p1"] },
    intent: "Mark the idea-gathering step done",
  }),
  evt(120, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_complete_p1",
    durationMs: 2,
    result: {
      kind: "plan.updated",
      items: [
        { id: "p1", label: "Find ideas Claire has shared", status: "done" },
        { id: "p2", label: "Check what's already been bought", status: "in_progress" },
        { id: "p3", label: "Recommend", status: "pending" },
      ],
    },
  }),

  // ── Step 2: check each idea for a purchase / booking trace ───────────
  evt(800, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_search_necklace",
    tool: "search_documents",
    args: { query: "Marlowe Finch interlock pendant order confirmation", limit: 5 },
    intent: "Look for any purchase trace for the necklace",
  }),
  evt(900, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_search_necklace",
    durationMs: 172,
    result: {
      kind: "search.results",
      query: "Marlowe Finch interlock pendant order confirmation",
      durationMs: 172,
      candidates: 4,
      results: [
        {
          documentId: DOC.giftEmail,
          sourceType: "gmail",
          sourceId: "gmail:self",
          documentType: "email",
          title: "These are the things I actually want (so you stop asking)",
          snippet:
            "…I really like Marlowe & Finch — found this one: https://example.com/marlowe-finch/interlock-pendant…",
          ts: 1713813240000,
        },
      ],
    },
  }),
  evt(600, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_search_vase",
    tool: "search_documents",
    args: { query: "Wren faceted glass vase order confirmation Amazon", limit: 5 },
    intent: "Look for any purchase trace for the vase",
  }),
  evt(900, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_search_vase",
    durationMs: 184,
    result: {
      kind: "search.results",
      query: "Wren faceted glass vase order confirmation Amazon",
      durationMs: 184,
      candidates: 6,
      results: [
        {
          documentId: DOC.amazon,
          sourceType: "gmail",
          sourceId: "gmail:self",
          documentType: "email",
          title: "Your Amazon.co.uk order of Faceted Glass Vase 'Wren'",
          snippet:
            "Order #112-4480913-7762250 placed Wednesday, 24 April 2024 · 1 x Faceted Glass Vase 'Wren' — £64.00 · Delivery: Friday, 26 April 2024",
          ts: 1713951720000,
        },
        {
          documentId: DOC.giftEmail,
          sourceType: "gmail",
          sourceId: "gmail:self",
          documentType: "email",
          title: "These are the things I actually want (so you stop asking)",
          snippet:
            "…I found this vase on amazon, it would go well with our dining table :) https://example.com/p/wren-glass-vase…",
          ts: 1713813240000,
        },
      ],
    },
  }),
  evt(600, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_fetch_amazon",
    tool: "fetch_document",
    args: { documentId: DOC.amazon },
    intent: "Confirm what the Amazon order contained",
  }),
  evt(1100, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_fetch_amazon",
    durationMs: 244,
    result: {
      kind: "document",
      ref: {
        documentId: DOC.amazon,
        sourceType: "gmail",
        sourceId: "gmail:self",
        documentType: "email",
        title: "Your Amazon.co.uk order of Faceted Glass Vase 'Wren'",
        ts: 1713951720000,
      },
      document: {
        id: DOC.amazon,
        title: "Your Amazon.co.uk order of Faceted Glass Vase 'Wren'",
        content:
          "Hello John Smith,\n\nThank you for your order. We'll send a confirmation when your item ships.\n\n" +
          "Details:\nOrder #112-4480913-7762250\nPlaced on Wednesday, 24 April 2024\n\n" +
          "1 x Faceted Glass Vase 'Wren' — Etched Bird Botanical Design Flower Vase — 25cm  £64.00\n" +
          "Delivery: Friday, 26 April 2024\n\nDispatch to: John Smith, [redacted]\n\nOrder total: £64.00 (incl. delivery)",
      },
    },
  }),
  evt(600, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_amazon",
    tool: "annotate",
    args: {
      documentId: DOC.amazon,
      quote:
        "1 x Faceted Glass Vase 'Wren' — Etched Bird Botanical Design Flower Vase — 25cm  £64.00 · Placed on Wednesday, 24 April 2024",
      quoteAuthor: "You",
    },
    intent: "Annotate the Amazon order line confirming the vase was already gifted",
  }),
  evt(220, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_amazon",
    durationMs: 7,
    result: {
      kind: "annotate.recorded",
      documentId: DOC.amazon,
      ref: {
        documentId: DOC.amazon,
        sourceType: "gmail",
        sourceId: "gmail:self",
        documentType: "email",
        title: "Your Amazon.co.uk order of Faceted Glass Vase 'Wren'",
        ts: 1713951720000,
      },
      quote:
        "1 x Faceted Glass Vase 'Wren' — Etched Bird Botanical Design Flower Vase — 25cm  £64.00 · Placed on Wednesday, 24 April 2024",
      quoteAuthor: "You",
    },
  }),
  evt(600, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_search_massage",
    tool: "search_documents",
    args: { query: "Lumen Baths massage booking confirmation", limit: 5 },
    intent: "Look for any booking trace for the spa day",
  }),
  evt(900, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_search_massage",
    durationMs: 168,
    result: {
      kind: "search.results",
      query: "Lumen Baths massage booking confirmation",
      durationMs: 168,
      candidates: 3,
      results: [
        {
          documentId: DOC.giftEmail,
          sourceType: "gmail",
          sourceId: "gmail:self",
          documentType: "email",
          title: "These are the things I actually want (so you stop asking)",
          snippet:
            "…Steph told me about Lumen Baths, apparently they do great massages :) https://example.com/lumen-baths…",
          ts: 1713813240000,
        },
      ],
    },
  }),
  evt(600, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_search_sourdough",
    tool: "search_documents",
    args: { query: "Flourhouse sourdough workshop booking confirmation", limit: 5 },
    intent: "Look for any booking trace for the sourdough workshop",
  }),
  evt(900, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_search_sourdough",
    durationMs: 175,
    result: {
      kind: "search.results",
      query: "Flourhouse sourdough workshop booking confirmation",
      durationMs: 175,
      candidates: 2,
      results: [
        {
          documentId: DOC.sourdoughWA,
          sourceType: "whatsapp-messages",
          sourceId: "whatsapp-messages:self",
          documentType: "conversation",
          title: "Claire — 2025-02-08",
          snippet: 'Claire: "We could do this workshop https://example.com/flourhouse/sourdough…"',
          ts: 1739010780000,
        },
      ],
    },
  }),

  // ── Mark plan step 2 done, advance to step 3 ─────────────────────────
  evt(300, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_complete_p2",
    tool: "plan",
    args: { complete: ["p2"] },
    intent: "Mark the purchase-history step done",
  }),
  evt(120, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_complete_p2",
    durationMs: 2,
    result: {
      kind: "plan.updated",
      items: [
        { id: "p1", label: "Find ideas Claire has shared", status: "done" },
        { id: "p2", label: "Check what's already been bought", status: "done" },
        { id: "p3", label: "Recommend", status: "in_progress" },
      ],
    },
  }),

  // ── Final summary table + recommendation ─────────────────────────────
  evt(300, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      "Claire's flagged four things over the last couple of years — and you've already bought one of them:\n\n" +
      "| Idea | Where she mentioned it | Already done? |\n" +
      "| --- | --- | --- |\n" +
      `| [Marlowe & Finch interlock pendant](${NECKLACE_URL}) | Email, Apr 2024 | No purchase trace |\n` +
      `| [Faceted glass vase 'Wren'](${VASE_URL}) | Email, Apr 2024 | **Already bought** — Amazon, 24 Apr 2024 |\n` +
      `| [Massage at Lumen Baths](${SPA_URL}) | Email, Apr 2024 | No booking trace |\n` +
      `| [Flourhouse sourdough workshop](${WORKSHOP_URL}) | WhatsApp, Feb 2025 | No booking trace |\n\n` +
      "The vase was a previous-birthday gift, so it's off the table. Of the three left, the **Flourhouse workshop** is the only one she's brought up in the last year, and it's the most experiential — that'd be my pick. The **Marlowe & Finch pendant** is the safe \"yes\" if you'd rather give her something physical to open.",
  }),

  // ── Mark plan step 3 done ────────────────────────────────────────────
  evt(260, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_complete_p3",
    tool: "plan",
    args: { complete: ["p3"] },
    intent: "Mark the recommendation step done",
  }),
  evt(120, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_complete_p3",
    durationMs: 2,
    result: {
      kind: "plan.updated",
      items: [
        { id: "p1", label: "Find ideas Claire has shared", status: "done" },
        { id: "p2", label: "Check what's already been bought", status: "done" },
        { id: "p3", label: "Recommend", status: "done" },
      ],
    },
  }),
  evt(500, "agent.message.end", {
    sessionId: $S,
    messageId: $M,
    stopReason: "end_turn",
    usage: { inputTokens: 1620, outputTokens: 420, cacheReadTokens: 1180, cacheCreationTokens: 0 },
  }),
];

const out =
  "# Demo fixture — birthday gift-discovery scenario.\n" +
  "# Generated by build-birthday-gifts.mjs.\n" +
  "# User opens with: \"Claire's birthday's coming up — did she ever\n" +
  "# mention things she actually wants? Don't want to get her something\n" +
  '# we already have." The agent gathers ideas Claire shared across\n' +
  "# Gmail + WhatsApp, checks purchase history for each (the vase turns\n" +
  "# up an old Amazon order), then recommends from what's left.\n" +
  events.join("\n") +
  "\n";
writeFileSync(new URL("../birthday-gifts.jsonl", import.meta.url), out);
console.log(`wrote ${events.length} entries`);
