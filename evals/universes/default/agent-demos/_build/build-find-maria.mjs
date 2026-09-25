// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Builds the `find-maria` demo fixture — the agent showcase for the
 * new `lookup_people` tool's multi-candidate disambiguation surface.
 *
 * Scenario: user opens with "what emails did I get from Maria Smith
 * last week?". Three Marias appear in the disambiguation card; the
 * agent picks the most-active correspondent (Maria Smith from Acme,
 * who is seeded into the synthetic Gmail corpus at
 * `synth-gmail-maria-001..003`), then issues a `from:` search using
 * her work email.
 *
 * Grounding:
 *   - `Maria Smith` is a real persona in `packages/providers-synth/_common/data/cast.json`
 *     (`p_maria_smith`), so `$PERSON_Maria_Smith` resolves to the real
 *     people-row at session-create.
 *   - The three emails in the search step are real synth Gmail rows
 *     (`synth-gmail-maria-001/002/003`), so the `$DOC_*` placeholders
 *     resolve to the live indexed documents, and the annotations land
 *     on real refs the Citations drawer can navigate to.
 *   - The other two disambiguation candidates (Maria's "family" alias
 *     and a vendor "Maria Smith-Lopez") stay synthetic — they exist
 *     only to demonstrate the disambiguation card UI. The agent picks
 *     the real one.
 *
 * Run after edits:
 *   node evals/fixtures/agent/build-demo-find-maria.mjs
 */

import { writeFileSync } from "node:fs";

const $S = "$SESSION";
const $M = "$MSG";

function evt(afterMs, type, payload) {
  return JSON.stringify({ afterMs, event: { type, payload } });
}

const MARIA_WORK_EMAIL = "maria.smith@acme.example";
// Top pick — bound to the real synth persona via the gateway's
// `$PERSON_<Name>` placeholder substitution at session-create.
const MARIA_WORK_ID = "$PERSON_Maria_Smith";
// Two stylised "near-miss" candidates the disambiguation card shows
// alongside the real Maria. Synthetic ids — the agent does not act
// on them; they exist purely so the rolling-slot card has 3 rows.
const MARIA_PERSONAL_ID = "p_maria_smith_family_demo";
const MARIA_VENDOR_ID = "p_maria_smith_lopez_demo";

// Real synth Gmail documents in `packages/providers-synth/google/data/gmail/messages.json`.
const DOC = {
  forecast: "$DOC_synth-gmail-maria-001",
  vendor: "$DOC_synth-gmail-maria-002",
  soc2: "$DOC_synth-gmail-maria-003",
};

const events = [
  evt(400, "agent.message.start", { sessionId: $S, messageId: $M, role: "assistant" }),
  evt(140, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta: "You have a few Marias — let me disambiguate, then pull last week's emails.",
  }),

  // ── Plan: three items ────────────────────────────────────────────────
  evt(300, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_plan_setup",
    tool: "plan",
    args: {
      add: [
        "Resolve which Maria you mean",
        "Pull last week's emails from her",
        "Summarize what's in them",
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
        { id: "p1", label: "Resolve which Maria you mean", status: "in_progress" },
        { id: "p2", label: "Pull last week's emails from her", status: "pending" },
        { id: "p3", label: "Summarize what's in them", status: "pending" },
      ],
    },
  }),

  // ── Step 1: disambiguate the right Maria ─────────────────────────────
  evt(500, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_lookup_maria",
    tool: "lookup_people",
    args: { query: "Maria Smith" },
    intent: "Resolve which Maria the user means before searching her emails",
  }),
  evt(900, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_lookup_maria",
    durationMs: 22,
    result: {
      kind: "person.results",
      query: "Maria Smith",
      durationMs: 22,
      results: [
        {
          canonicalId: MARIA_WORK_ID,
          displayName: "Maria Smith",
          aliases: [MARIA_WORK_EMAIL, "+15550133"],
          emailCount: 3,
          chatCount: 0,
          meetingCount: 0,
          lastInteraction: 1758811820000,
          interactionScore: 0.84,
        },
        {
          canonicalId: MARIA_PERSONAL_ID,
          displayName: "Maria Smith",
          aliases: ["maria.family@example.org"],
          emailCount: 5,
          lastInteraction: 1715000000000,
          interactionScore: 0.18,
        },
        {
          canonicalId: MARIA_VENDOR_ID,
          displayName: "Maria Smith-Lopez",
          aliases: ["maria.lopez@example.org"],
          emailCount: 1,
          lastInteraction: 1700000000000,
          interactionScore: 0.04,
        },
      ],
    },
  }),

  // Agent narrates the pick — the ephemeral card just faded, so the
  // text reads naturally after the card disappears.
  evt(140, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      "\n\nThree candidates — going with `maria.smith@acme.example` (your most active correspondent named Maria Smith).",
  }),

  // ── Plan: mark step 1 done, advance to step 2 ───────────────────────
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
        { id: "p1", label: "Resolve which Maria you mean", status: "done" },
        { id: "p2", label: "Pull last week's emails from her", status: "in_progress" },
        { id: "p3", label: "Summarize what's in them", status: "pending" },
      ],
    },
  }),

  // ── Step 2: search using the chosen email + last-week window ─────────
  evt(700, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_search_maria_emails",
    tool: "search_documents",
    args: {
      query: `from:${MARIA_WORK_EMAIL} after:"last week"`,
      limit: 6,
    },
    intent: "Filter Maria's emails to the last week",
  }),
  evt(1400, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_search_maria_emails",
    durationMs: 192,
    result: {
      kind: "search.results",
      query: `from:${MARIA_WORK_EMAIL} after:"last week"`,
      durationMs: 192,
      candidates: 3,
      results: [
        {
          documentId: DOC.forecast,
          sourceType: "gmail",
          sourceId: "gmail:self",
          documentType: "email",
          title: "Re: Q4 forecast — final pass before Thursday review",
          snippet:
            "Sharing the trimmed forecast you asked for. The CAC line is the one I'd flag — happy to walk through on the Thursday call.",
          ts: 1758811820000,
        },
        {
          documentId: DOC.vendor,
          sourceType: "gmail",
          sourceId: "gmail:self",
          documentType: "email",
          title: "Vendor follow-up — Bluestone counter-offer",
          snippet:
            "They came back at $84k for the annual seat. Worth a 15min sync before we counter — Tuesday afternoon works for me.",
          ts: 1758663300000,
        },
        {
          documentId: DOC.soc2,
          sourceType: "gmail",
          sourceId: "gmail:self",
          documentType: "email",
          title: "Re: SOC2 readiness — week-7 checkpoint",
          snippet:
            "Auditor flagged two findings on the access-review evidence. Both are paperwork — no real gaps. Will fix and push to you Monday.",
          ts: 1758503700000,
        },
      ],
    },
  }),

  // ── Plan: mark step 2 done, advance to step 3 ───────────────────────
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
        { id: "p1", label: "Resolve which Maria you mean", status: "done" },
        { id: "p2", label: "Pull last week's emails from her", status: "done" },
        { id: "p3", label: "Summarize what's in them", status: "in_progress" },
      ],
    },
  }),

  // ── Step 3: annotate two of them as the load-bearing citations ───────
  evt(500, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_forecast",
    tool: "annotate",
    args: {
      documentId: DOC.forecast,
      quote: "The CAC line is the one I'd flag — happy to walk through on the Thursday call.",
      quoteAuthor: "Maria",
    },
    intent: "Anchor the Thursday-review CAC ask onto the forecast email",
  }),
  evt(220, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_forecast",
    durationMs: 5,
    result: {
      kind: "annotate.recorded",
      documentId: DOC.forecast,
      ref: {
        documentId: DOC.forecast,
        sourceType: "gmail",
        sourceId: "gmail:self",
        documentType: "email",
        title: "Re: Q4 forecast — final pass before Thursday review",
        ts: 1758811820000,
      },
      quote: "The CAC line is the one I'd flag — happy to walk through on the Thursday call.",
      quoteAuthor: "Maria",
    },
  }),

  evt(300, "agent.tool.start", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_vendor",
    tool: "annotate",
    args: {
      documentId: DOC.vendor,
      quote:
        "They came back at $84k for the annual seat. Worth a 15min sync before we counter — Tuesday afternoon works for me.",
      quoteAuthor: "Maria",
    },
    intent: "Pin the Bluestone counter + Maria's proposed Tuesday sync",
  }),
  evt(220, "agent.tool.result", {
    sessionId: $S,
    messageId: $M,
    toolCallId: "tc_annot_vendor",
    durationMs: 4,
    result: {
      kind: "annotate.recorded",
      documentId: DOC.vendor,
      ref: {
        documentId: DOC.vendor,
        sourceType: "gmail",
        sourceId: "gmail:self",
        documentType: "email",
        title: "Vendor follow-up — Bluestone counter-offer",
        ts: 1758663300000,
      },
      quote:
        "They came back at $84k for the annual seat. Worth a 15min sync before we counter — Tuesday afternoon works for me.",
      quoteAuthor: "Maria",
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
        { id: "p1", label: "Resolve which Maria you mean", status: "done" },
        { id: "p2", label: "Pull last week's emails from her", status: "done" },
        { id: "p3", label: "Summarize what's in them", status: "done" },
      ],
    },
  }),

  // ── Final answer ─────────────────────────────────────────────────────
  evt(220, "agent.text.delta", {
    sessionId: $S,
    messageId: $M,
    delta:
      "\n\nThree emails from Maria last week, all work-related:\n\n" +
      "- **Q4 forecast — final pass before Thursday review** — sharing the trimmed forecast you asked for. She wants to walk through the **CAC line** on the Thursday call.\n" +
      "- **Vendor follow-up — Bluestone counter-offer** — they came back at **$84k/seat** annual. Maria proposes a **15min sync Tuesday afternoon** before you counter.\n" +
      "- **SOC2 readiness — week-7 checkpoint** — two paperwork findings on the access-review evidence; she'll push fixes Monday.\n\n" +
      "Closest deadline: the **Thursday review**, where the CAC discussion is live.",
  }),

  evt(500, "agent.message.end", {
    sessionId: $S,
    messageId: $M,
    stopReason: "end_turn",
    usage: { inputTokens: 980, outputTokens: 310, cacheReadTokens: 760, cacheCreationTokens: 0 },
  }),
];

const out =
  "# Demo fixture — find-maria scenario.\n" +
  "# Generated by build-demo-find-maria.mjs.\n" +
  '# User opens with: "What emails did I get from Maria Smith last week?"\n' +
  "# The agent uses `lookup_people` to disambiguate three Marias, picks the\n" +
  "# top one by interactionScore, then searches her emails with the\n" +
  "# `from:<her-email> after:'last week'` operator and annotates the two\n" +
  "# load-bearing results. Grounded on real synth-gmail-maria-001..003.\n" +
  events.join("\n") +
  "\n";
writeFileSync(new URL("../find-maria.jsonl", import.meta.url), out);
console.log(`wrote ${events.length} entries`);
