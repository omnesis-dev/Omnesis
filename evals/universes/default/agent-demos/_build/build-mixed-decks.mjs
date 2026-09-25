// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Builds the "mixed source decks" demo fixture. Exercises the
 * sticky-tab deck compaction at multiple depths simultaneously:
 *
 *   • 3 Gmail threads → a 3-tab deck (deepest pile).
 *   • 2 WhatsApp conversations → a 2-tab deck.
 *   • 1 Google Drive file → a 1-tab solo.
 *
 * Citations interleave across sources so the user sees the decks
 * grow in parallel during streaming, not in pre-grouped batches.
 *
 * Trigger phrase: "test mixed source decks" (see sibling meta.json).
 *
 * Run after edits:
 *   node evals/fixtures/agent/build-demo-mixed-decks.mjs
 */

import { writeFileSync } from "node:fs";

const $S = "$SESSION";
const $M = "$MSG";

// Interleaved order: g, w, g, d, w, g — so the user sees the Gmail
// deck grow to 3, WhatsApp to 2, Drive land in the middle. External IDs
// match the synth providers' first few records so $DOC_… placeholders
// resolve at session-create.
const CITATIONS = [
  {
    external: "synth-gmail-001",
    sourceType: "gmail",
    sourceId: "gmail:self",
    documentType: "email",
    title: "Re: Q1 budget review",
    quote: "Approving the cloud-spend line item — let's revisit in March.",
    quoteAuthor: "Sam",
  },
  {
    external: "synth-whatsapp-001",
    sourceType: "whatsapp-messages",
    sourceId: "whatsapp-messages:self",
    documentType: "message",
    title: "Climbing group — Tuesday session",
    quote: "Indoor at 7pm — usual spot. Bring belay device if you have one.",
    quoteAuthor: "Jake",
  },
  {
    external: "synth-gmail-002",
    sourceType: "gmail",
    sourceId: "gmail:self",
    documentType: "email",
    title: "Wedding venue — final headcount",
    quote: "Locking in 78 guests; venue confirmed at 14:00 walk-through.",
    quoteAuthor: "Lila",
  },
  {
    external: "synth-gdrive-001",
    sourceType: "google-drive",
    sourceId: "google-drive:self",
    documentType: "file",
    title: "2026 product roadmap.pdf",
    quote: "Q2 milestone: ship the iOS push-notification pipeline.",
  },
  {
    external: "synth-whatsapp-002",
    sourceType: "whatsapp-messages",
    sourceId: "whatsapp-messages:self",
    documentType: "message",
    title: "Mom — Sunday 7:42 PM",
    quote: "Don't forget your sister's birthday is on the 22nd.",
    quoteAuthor: "Mom",
  },
  {
    external: "synth-gmail-003",
    sourceType: "gmail",
    sourceId: "gmail:self",
    documentType: "email",
    title: "Re: [EXTERNAL] FibreCo vs MetroNet at 42 Example Street",
    quote: "I would love to know what metronet can offer to compete with fibreco's pricing.",
    quoteAuthor: "You",
  },
];

function seededPrng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}
const rand = seededPrng(0xdec7ab5);

function gap() {
  return 220 + Math.floor(rand() * 420);
}

function evt(afterMs, type, payload) {
  return JSON.stringify({ afterMs, event: { type, payload } });
}

const events = [];

events.push(evt(350, "agent.message.start", { sessionId: $S, messageId: $M, role: "assistant" }));
events.push(
  evt(140, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      "Citing a mixed bag to exercise the deck compaction — 3 Gmail threads, 2 WhatsApp chats, 1 Drive file.",
  }),
);

let tcIdx = 0;
for (const src of CITATIONS) {
  const tcId = `tc_mix_${++tcIdx}_${src.sourceType.replace(/[^a-z0-9]/gi, "_")}`;
  const docId = `$DOC_${src.external}`;
  const args = { documentId: docId };
  if (src.quote) args.quote = src.quote;
  if (src.quoteAuthor) args.quoteAuthor = src.quoteAuthor;
  if (src.note) args.note = src.note;

  events.push(
    evt(gap(), "agent.tool.start", {
      sessionId: $S,
      messageId: $M,
      toolCallId: tcId,
      tool: "annotate",
      args,
      intent: `Annotate ${src.title}`,
    }),
  );
  const result = {
    kind: "annotate.recorded",
    documentId: docId,
    ref: {
      documentId: docId,
      sourceType: src.sourceType,
      sourceId: src.sourceId,
      documentType: src.documentType,
      title: src.title,
      ts: 1_757_237_400_000 + tcIdx * 86_400_000,
    },
  };
  if (src.quote) result.quote = src.quote;
  if (src.quoteAuthor) result.quoteAuthor = src.quoteAuthor;
  if (src.note) result.note = src.note;
  events.push(
    evt(180 + Math.floor(rand() * 140), "agent.tool.result", {
      sessionId: $S,
      messageId: $M,
      toolCallId: tcId,
      durationMs: 5 + Math.floor(rand() * 8),
      result,
    }),
  );
}

events.push(
  evt(420, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      "\n\nDecks: 3-tab Gmail, 2-tab WhatsApp, 1-tab Drive. Tap a deck or swipe from the right to inspect.",
  }),
);
events.push(
  evt(400, "agent.message.end", {
    sessionId: $S,
    messageId: $M,
    stopReason: "end_turn",
    usage: { inputTokens: 180, outputTokens: 64, cacheReadTokens: 160, cacheCreationTokens: 0 },
  }),
);

const out =
  "# Demo fixture — mixed source decks (3 gmail + 2 whatsapp + 1 drive).\n" +
  "# Generated by build-demo-mixed-decks.mjs.\n" +
  events.join("\n") +
  "\n";
writeFileSync(new URL("../mixed-decks.jsonl", import.meta.url), out);
console.log(`wrote ${events.length} entries (${CITATIONS.length} citations)`);
