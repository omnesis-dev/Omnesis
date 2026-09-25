// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Builds the "all sticky tabs" demo fixture. Streams one citation per
 * implemented source over a single short reply so QA can eyeball the
 * iOS citation sticky-tab stack at full breadth — every source-color
 * palette rendered side-by-side, crowding behaviour at high tab counts,
 * and the live-arrival animation as tabs accumulate.
 *
 * Trigger phrase: "testing all sticky tabs" (see sibling .meta.json).
 *
 * Annotate tool calls are silent (no inline rendering); the demo's surface
 * is the citation drawer + the per-message count chip + the sticky tabs.
 *
 * Run after edits:
 *   node evals/fixtures/agent/build-demo-all-sticky-tabs.mjs
 */

import { writeFileSync } from "node:fs";

const $S = "$SESSION";
const $M = "$MSG";

// One entry per implemented source. `external` is the synthetic
// external-id (must match the placeholders array in
// `demos/all-sticky-tabs.meta.json` so the synth gateway can stamp the
// real doc id at replay time). `sourceType` and `sourceId` are what
// the iOS app keys icons + colors off.
const SOURCES = [
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
    external: "synth-gcal-001",
    sourceType: "google-calendar",
    sourceId: "google-calendar:self",
    documentType: "event",
    title: "Wedding venue walk-through",
    quote: "Confirmed for 14:00 — bring the chair-count estimate.",
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
    external: "synth-gcontact-001",
    sourceType: "google-contacts",
    sourceId: "google-contacts:self",
    documentType: "contact",
    title: "Quentin Marais",
    note: "Friend who keeps recommending Parisian restaurants",
  },
  {
    external: "synth-apple-note-001",
    sourceType: "apple-notes",
    sourceId: "apple-notes:local",
    documentType: "note",
    title: "Kitchen renovation — vendor list",
    quote: "Stone supplier called back — full slab available end of month.",
  },
  {
    external: "synth-apple-rem-001",
    sourceType: "apple-reminders",
    sourceId: "apple-reminders:local",
    documentType: "reminder",
    title: "Pay the quarterly insurance bill",
    note: "Due Friday — auto-pay was suspended last month",
  },
  {
    external: "synth-apple-im-001",
    sourceType: "apple-imessage",
    sourceId: "apple-imessage:local",
    documentType: "message",
    title: "Mom — Sunday 7:42 PM",
    quote: "Don't forget your sister's birthday is on the 22nd.",
    quoteAuthor: "Mom",
  },
  {
    external: "synth-apple-contact-001",
    sourceType: "apple-contacts",
    sourceId: "apple-contacts:local",
    documentType: "contact",
    title: "Dr. Elena Ramos",
    note: "Cardiologist — referral from primary care",
  },
  {
    external: "synth-notion-page-001",
    sourceType: "notion-pages",
    sourceId: "notion-pages:self",
    documentType: "note",
    title: "Vendor evaluation — comparison matrix",
    quote: "Globex still pending SOC2 — Initech ready to sign.",
  },
  {
    external: "db-db_projects",
    sourceType: "notion-databases",
    sourceId: "notion-databases:self",
    documentType: "note",
    title: "[Db] Projects",
    note: "First-class Notion database surfaced via summary doc + per-row docs.",
  },
  {
    external: "synth-chrome-bm-001",
    sourceType: "chrome-bookmarks",
    sourceId: "chrome-bookmarks:default",
    documentType: "bookmark",
    title: "SwiftUI gesture cheat-sheet",
    note: "Bookmarked when I was debugging the right-edge swipe",
  },
  {
    external: "synth-obsidian-001",
    sourceType: "obsidian-notes",
    sourceId: "obsidian-notes:vault",
    documentType: "note",
    title: "On taste in software",
    quote: "Taste is the gradient between what works and what's right.",
  },
  {
    external: "synth-things-001",
    sourceType: "things",
    sourceId: "things:local",
    documentType: "task",
    title: "Review pull request #1042",
    note: "Tagged @inbox — escalate if not done by EOD",
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
    external: "synth-outlook-001",
    sourceType: "outlook-email",
    sourceId: "outlook-email:work",
    documentType: "email",
    title: "FW: Compliance training — due reminder",
    quote: "All staff must complete module 4 before March 31.",
    quoteAuthor: "Priya",
  },
  {
    external: "synth-strava-001",
    sourceType: "strava-activities",
    sourceId: "strava-activities:self",
    documentType: "activity",
    title: "Sunday long run — 18.2 km",
    quote: "Average pace 5:24/km — best half-marathon split since November.",
  },
  // browser-history and screen-time intentionally absent: those synth
  // sources emit DuckDB analytics rows (no Documents), so citations
  // can't reference them. Sticky-tab demo covers the 17 sources that
  // do emit Documents — palette-wise that's still the full breadth.
];

// Pseudo-random gap between successive cite events to avoid the
// machine-gun feel of constant 220ms ticks. Uses a tiny seeded PRNG so
// the generated fixture is deterministic across runs.
function seededPrng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}
const rand = seededPrng(0xc17a73d);

function gap() {
  // 120–520ms — feels human-paced without being annoyingly slow.
  return 120 + Math.floor(rand() * 400);
}

function evt(afterMs, type, payload) {
  return JSON.stringify({ afterMs, event: { type, payload } });
}

const events = [];

events.push(evt(350, "agent.message.start", { sessionId: $S, messageId: $M, role: "assistant" }));
events.push(
  evt(120, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      "Spinning up one citation per source so you can see the full palette of sticky tabs in one go.",
  }),
);

let tcIdx = 0;
for (const src of SOURCES) {
  const tcId = `tc_annot_${++tcIdx}_${src.sourceType.replace(/[^a-z0-9]/gi, "_")}`;
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
      ts: 1757237400000 + tcIdx * 86_400_000,
    },
  };
  if (src.quote) result.quote = src.quote;
  if (src.quoteAuthor) result.quoteAuthor = src.quoteAuthor;
  if (src.note) result.note = src.note;
  events.push(
    evt(160 + Math.floor(rand() * 120), "agent.tool.result", {
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
    delta: `\n\nThat's ${SOURCES.length} sources cited. Swipe from the right edge or tap a tab to inspect any of them.`,
  }),
);
events.push(
  evt(400, "agent.message.end", {
    sessionId: $S,
    messageId: $M,
    stopReason: "end_turn",
    usage: { inputTokens: 220, outputTokens: 80, cacheReadTokens: 200, cacheCreationTokens: 0 },
  }),
);

const out =
  "# Demo fixture — all sticky tabs (one citation per implemented source).\n" +
  "# Generated by build-demo-all-sticky-tabs.mjs.\n" +
  events.join("\n") +
  "\n";
writeFileSync(new URL("../all-sticky-tabs.jsonl", import.meta.url), out);
console.log(`wrote ${events.length} entries (${SOURCES.length} sources)`);
