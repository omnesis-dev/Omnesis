// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Builds the `url-lookup` demo fixture — the agent showcase for the
 * new `lookup_document_by_url` tool.
 *
 * Scenario: user pastes a Google Drive URL and asks the agent to
 * summarise the document at that URL. The URL is grounded in the
 * synth provider's fixture corpus (the Vendor evaluation matrix
 * Drive file, externalId `synth-gdrive-002`) so the lookup actually
 * resolves end-to-end against a live demo gateway running the synth
 * providers.
 *
 * Flow:
 *   1. `lookup_document_by_url({ url })` — gateway canonicalises the
 *      pasted URL and returns a single ref (DocRef shape).
 *   2. `fetch_document({ documentId })` — agent reads the body.
 *   3. Summarises and annotates the doc as the load-bearing source.
 *
 * Run after edits:
 *   node evals/fixtures/agent/build-demo-url-lookup.mjs
 *
 * Routing triggers + placeholder declarations live in the sibling
 * `demos/url-lookup.meta.json` file.
 */

import { writeFileSync } from "node:fs";

const $S = "$SESSION";
const $M = "$MSG";

// A realistic-looking Google Drive file link, the kind a colleague
// would paste into chat. The canned `lookup_document_by_url` result
// below maps it to the indexed Drive matrix via the `$DOC_` placeholder,
// which the gateway resolves to the real synth document at session
// start — so the citation opens the correct doc even though the visible
// URL is illustrative.
const DRIVE_URL = "https://drive.google.com/file/d/1q7Kp3vR9mB2nF8xLZ4wYcJ6tH0sD5aGe/view";
const DOC_DRIVE = "$DOC_synth-gdrive-002";

function evt(afterMs, type, payload) {
  return JSON.stringify({ afterMs, event: { type, payload } });
}

const events = [
  evt(400, "agent.message.start", { sessionId: $S, messageId: $M, role: "assistant" }),
  evt(140, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta: "Let me resolve that link to the indexed copy, then read it.",
  }),

  // ── Plan: three short steps ─────────────────────────────────────────
  evt(280, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_setup",
    tool: "plan",
    args: {
      add: ["Resolve the URL to the indexed doc", "Open the body", "Summarise what's in it"],
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
        { id: "p1", label: "Resolve the URL to the indexed doc", status: "in_progress" },
        { id: "p2", label: "Open the body", status: "pending" },
        { id: "p3", label: "Summarise what's in it", status: "pending" },
      ],
    },
  }),

  // ── Step 1: reverse-lookup the URL to a documentId ───────────────────
  evt(500, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_url_lookup",
    tool: "lookup_document_by_url",
    args: { url: DRIVE_URL },
    intent: "Resolve the pasted URL against the corpus",
  }),
  evt(700, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_url_lookup",
    durationMs: 9,
    result: {
      kind: "document.byUrl",
      url: DRIVE_URL,
      durationMs: 9,
      ref: {
        documentId: DOC_DRIVE,
        sourceType: "google-drive",
        sourceId: "google-drive:self",
        documentType: "file",
        mimeType: "application/vnd.google-apps.spreadsheet",
        title: "Vendor evaluation matrix.gsheet",
        snippet:
          "Vendor,Throughput,SOC2,Pricing,Support · Globex,High,Pending Nov,$$,Tier 2 · Nimbus,Medium,Yes,$$$,Tier 1",
        ts: 1757237400000,
        url: DRIVE_URL,
        unitName: "files",
      },
    },
  }),

  // ── Plan: mark step 1 done ──────────────────────────────────────────
  evt(120, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p1",
    tool: "plan",
    args: { complete: ["p1"] },
  }),
  evt(80, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p1",
    durationMs: 2,
    result: {
      kind: "plan.updated",
      items: [
        { id: "p1", label: "Resolve the URL to the indexed doc", status: "done" },
        { id: "p2", label: "Open the body", status: "in_progress" },
        { id: "p3", label: "Summarise what's in it", status: "pending" },
      ],
    },
  }),

  // ── Step 2: fetch the body for the actual summary ────────────────────
  evt(700, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_fetch_drive",
    tool: "fetch_document",
    args: { documentId: DOC_DRIVE },
    intent: "Read the matrix in full",
  }),
  evt(1400, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_fetch_drive",
    durationMs: 18,
    result: {
      kind: "document",
      ref: {
        documentId: DOC_DRIVE,
        sourceType: "google-drive",
        sourceId: "google-drive:self",
        documentType: "file",
        mimeType: "application/vnd.google-apps.spreadsheet",
        title: "Vendor evaluation matrix.gsheet",
        ts: 1757237400000,
        url: DRIVE_URL,
      },
      document: {
        id: DOC_DRIVE,
        title: "Vendor evaluation matrix.gsheet",
        content:
          "Vendor,Throughput,SOC2,Pricing,Support\n" +
          "Globex,High,Pending Nov,$$,Tier 2\n" +
          "Nimbus,Medium,Yes,$$$,Tier 1",
      },
    },
  }),

  // ── Plan: mark step 2 done ──────────────────────────────────────────
  evt(120, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p2",
    tool: "plan",
    args: { complete: ["p2"] },
  }),
  evt(80, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p2",
    durationMs: 2,
    result: {
      kind: "plan.updated",
      items: [
        { id: "p1", label: "Resolve the URL to the indexed doc", status: "done" },
        { id: "p2", label: "Open the body", status: "done" },
        { id: "p3", label: "Summarise what's in it", status: "in_progress" },
      ],
    },
  }),

  // ── Step 3: annotate as the citing source ────────────────────────────
  evt(500, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_drive",
    tool: "annotate",
    args: {
      documentId: DOC_DRIVE,
      quote: "Globex,High,Pending Nov,$$,Tier 2",
    },
    intent: "Anchor the Globex/SOC2 fact onto the matrix row",
  }),
  evt(220, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_drive",
    durationMs: 4,
    result: {
      kind: "annotate.recorded",
      documentId: DOC_DRIVE,
      ref: {
        documentId: DOC_DRIVE,
        sourceType: "google-drive",
        sourceId: "google-drive:self",
        documentType: "file",
        mimeType: "application/vnd.google-apps.spreadsheet",
        title: "Vendor evaluation matrix.gsheet",
        ts: 1757237400000,
        url: DRIVE_URL,
      },
      quote: "Globex,High,Pending Nov,$$,Tier 2",
    },
  }),

  // ── Plan: mark step 3 done ──────────────────────────────────────────
  evt(120, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p3",
    tool: "plan",
    args: { complete: ["p3"] },
  }),
  evt(80, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_p3",
    durationMs: 2,
    result: {
      kind: "plan.updated",
      items: [
        { id: "p1", label: "Resolve the URL to the indexed doc", status: "done" },
        { id: "p2", label: "Open the body", status: "done" },
        { id: "p3", label: "Summarise what's in it", status: "done" },
      ],
    },
  }),

  // ── Final answer ─────────────────────────────────────────────────────
  evt(220, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      "\n\n**Vendor evaluation matrix** — comparing **Globex** and **Nimbus** across four axes:\n\n" +
      "| | Throughput | SOC2 | Pricing | Support |\n" +
      "|---|---|---|---|---|\n" +
      "| Globex | High | Pending Nov | $$ | Tier 2 |\n" +
      "| Nimbus | Medium | Yes | $$$ | Tier 1 |\n\n" +
      "Globex leads on throughput and price; the blocker is **SOC2 (pending November)**. Nimbus is SOC2-ready today but a tier slower and noticeably pricier.",
  }),

  evt(500, "agent.message.end", {
    sessionId: $S,
    messageId: $M,
    stopReason: "end_turn",
    usage: { inputTokens: 760, outputTokens: 240, cacheReadTokens: 580, cacheCreationTokens: 0 },
  }),
];

const out =
  "# Demo fixture — url-lookup scenario.\n" +
  "# Generated by build-demo-url-lookup.mjs.\n" +
  "# User opens by pasting a Google Drive URL and asking the agent to\n" +
  "# summarise the document at that URL. The agent calls\n" +
  "# `lookup_document_by_url` to resolve the URL → document, then\n" +
  "# `fetch_document` to read the body, then annotates and answers.\n" +
  events.join("\n") +
  "\n";
writeFileSync(new URL("../url-lookup.jsonl", import.meta.url), out);
console.log(`wrote ${events.length} entries`);
